'use strict';

var node    = require('../../node.js');
var _       = node._;
var bignum  = node.bignum;
var expect  = node.expect;
var slots   = require('../../../helpers/slots.js');
var Promise = require('bluebird');

describe('SQL triggers related to accounts', function () {
	var library, processed_txs = [];

	before(function (done) {
		node.initApplication(function (scope) {
			library = scope;

			// Set delegates module as loaded to allow manual forging
			library.rewiredModules.delegates.__set__('__private.loaded', true);

			setTimeout(done, 10000);
		})
	});

	before(function (done) {
		// Load forging delegates
		var loadDelegates = library.rewiredModules.delegates.__get__('__private.loadDelegates');
		loadDelegates(done);
	});

	function normalizeAccounts(rows) {
		var accounts = {};
		_.each(rows, function (row) {
			accounts[row.address] = {
				tx_id: row.tx_id,
				pk: row.pk ? row.pk.toString('hex') : null,
				pk_tx_id: row.pk_tx_id,
				second_pk: row.second_pk ? row.second_pk.toString('hex') : null,
				address: row.address,
				balance: row.balance
			};
		});
		return accounts;
	};

	function getAccounts () {
		return library.db.query('SELECT * FROM accounts').then(function (rows) {
			return normalizeAccounts(rows);
		});
	};

	function getAccountByAddress (address) {
		return library.db.query('SELECT * FROM accounts WHERE address = ${address}', {address: address}).then(function (rows) {
			return normalizeAccounts(rows);
		});
	};

	function getExpectedAccounts(transactions) {
		var expected = {};
		_.each(transactions, function (tx) {
			// Update recipient
			if (tx.recipientId) {
				if (!expected[tx.recipientId]) {
					expected[tx.recipientId] = {
						tx_id: tx.id,
						pk: null,
						pk_tx_id: null,
						second_pk: null,
						address: tx.recipientId,
						balance: tx.amount
					}
				} else {
					expected[tx.recipientId].balance = new bignum(expected[tx.recipientId].balance).plus(tx.amount).toString();
				}
			}

			// Update sender
			if (!expected[tx.senderId]) {
				expected[tx.senderId] = {
					tx_id: tx.id,
					pk: tx.senderPublicKey,
					pk_tx_id: tx.id,
					second_pk: null,
					address: tx.senderId,
					balance: new bignum(0).minus(tx.amount).minus(tx.fee).toString()
				};
			} else {
				if (!expected[tx.senderId].pk) {
					expected[tx.senderId].pk = tx.senderPublicKey;
					expected[tx.senderId].pk_tx_id = tx.id;
				}
				expected[tx.senderId].balance = new bignum(expected[tx.senderId].balance).minus(tx.amount).minus(tx.fee).toString();
			}
		});
		return expected;
	}

	function forge (cb) {
		function getNextForger(offset) {
			offset = !offset ? 1 : offset;

			var last_block = library.modules.blocks.lastBlock.get();
			var slot = slots.getSlotNumber(last_block.timestamp);
			return library.rewiredModules.delegates.__get__('__private.delegatesList')[(slot + offset) % slots.delegates];
		};

		var transactionPool = library.rewiredModules.transactions.__get__('__private.transactionPool');
		var keypairs = library.rewiredModules.delegates.__get__('__private.keypairs');

		node.async.series([
			transactionPool.fillPool,
			function (seriesCb) {
				var last_block = library.modules.blocks.lastBlock.get();
				var slot = slots.getSlotNumber(last_block.timestamp) + 1;
				var delegate = getNextForger();
				var keypair = keypairs[delegate];
				//node.debug('		Last block height: ' + last_block.height + ' Last block ID: ' + last_block.id + ' Last block timestamp: ' + last_block.timestamp + ' Next slot: ' + slot + ' Next delegate PK: ' + delegate + ' Next block timestamp: ' + slots.getSlotTime(slot));
				library.modules.blocks.process.generateBlock(keypair, slots.getSlotTime(slot), function (err) {
					if (err) { return seriesCb(err); }
					last_block = library.modules.blocks.lastBlock.get();
					//node.debug('		New last block height: ' + last_block.height + ' New last block ID: ' + last_block.id);
					return seriesCb(err);
				});
			}
		], function (err) {
			cb(err);
		});
	}

	function addTransactionsAndForge (transactions, cb) {
		function addTransaction (transaction, cb) {
			//node.debug('	Add transaction ID: ' + transaction.id);
			// Add transaction to transactions pool - we use shortcut here to bypass transport module, but logic is the same
			// See: modules.transport.__private.receiveTransaction
			transaction = library.logic.transaction.objectNormalize(transaction);
			// Add transaction to processed_txs
			processed_txs.push(transaction);
			library.balancesSequence.add(function (sequenceCb) {
				library.modules.transactions.processUnconfirmedTransaction(transaction, true, function (err) {
					if (err) {
						return setImmediate(sequenceCb, err.toString());
					} else {
						return setImmediate(sequenceCb, null, transaction.id);
					}
				});
			}, cb);
		}

		node.async.waterfall([
			function addTransactions (waterCb) {
				node.async.eachSeries(transactions, function (transaction, eachSeriesCb) {
					addTransaction(transaction, eachSeriesCb);
				}, waterCb);
			},
			forge
		], function (err) {
			cb(err);
		});
	}

	describe('balances calculations', function () {
		var balance = '9999999807716836';
		var amount = '950525433';
		var fee = '10000000';
		var expected = '9999998847191403';

		it('using JavaScript should fail', function () {
			var result = (Number(balance) - (Number(amount) + Number(fee))).toString();
			expect(result).to.not.equal(expected);
		});

		it('using BigNumber should be ok', function () {
			var result = new bignum(balance).minus(new bignum(amount).plus(fee)).toString();
			expect(result).to.equal(expected);
		});

		it('using PostgreSQL should be ok', function () {
			return library.db.query('SELECT (${balance}::bigint - (${amount}::bigint + ${fee}::bigint)) AS result', {balance: balance, amount: amount, fee: fee}).then(function (rows) {
				expect(rows[0].result).to.equal(expected);
			});
		});
	})

	describe('accounts table', function () {

		it('initial state should match genesis block', function () {
			var genesis_transactions = library.genesisblock.block.transactions;
			var expected = getExpectedAccounts(genesis_transactions);

			return getAccounts().then(function (accounts) {
				expect(accounts).to.deep.equal(expected);
			});
		});

		describe('transactions', function () {
			var last_random_account;

			describe ('single, type TRANSFER - 0 from non-virgin account', function () {
				var sender_before;
				var transactions = [];

				before(function () {
					last_random_account = node.randomAccount();
					var tx = node.lisk.transaction.createTransaction(
						last_random_account.address,
						node.randomNumber(100000000, 1000000000),
						node.gAccount.password
					);
					transactions.push(tx);

					return getAccountByAddress(node.gAccount.address).then(function (accounts) {
						sender_before = accounts[node.gAccount.address];
						return Promise.promisify(addTransactionsAndForge)(transactions);
					});

				});

				describe('sender', function () {

					it('should substract balance', function () {
						return getAccountByAddress(node.gAccount.address).then(function (accounts) {
							var sender = accounts[node.gAccount.address];
							var tx = transactions[0];
							sender_before.balance = new bignum(sender_before.balance).minus(tx.amount).minus(tx.fee).toString();
							expect(sender_before.balance).to.equal(sender.balance);
						});
					});
				});

				describe('recipient', function () {
					var recipient, tx;

					before(function () {
						tx = transactions[0];
						return getAccountByAddress(tx.recipientId).then(function (accounts) {
							recipient = accounts[tx.recipientId];
						});
					});

					it('should create account', function () {
						expect(recipient.address).to.be.equal(tx.recipientId);
					});

					it('should set tx_id', function () {
						expect(recipient.tx_id).to.be.equal(tx.id);
					});

					it('should not set pk, pk_tx_id, second_pk', function () {
						expect(recipient.pk).to.be.null;
						expect(recipient.pk_tx_id).to.be.null;
						expect(recipient.second_pk).to.be.null;
					});

					it('should credit balance', function () {
						expect(recipient.balance).to.equal(tx.amount.toString());
					});
				});
			});

			describe ('single, type TRANSFER - 0 from virgin account', function () {
				var sender_before;
				var transactions = [];

				before(function () {
					return getAccountByAddress(last_random_account.address).then(function (accounts) {						
						sender_before = accounts[last_random_account.address];

						var tx = node.lisk.transaction.createTransaction(
							node.randomAccount().address,
							node.randomNumber(1, new bignum(sender_before.balance).minus(10000000).toNumber()),
							last_random_account.password
						);
						transactions.push(tx);

						return Promise.promisify(addTransactionsAndForge)(transactions);
					});

				});

				describe('sender', function () {
					var sender, tx;

					before(function () {
						tx = transactions[0];
						return getAccountByAddress(tx.senderId).then(function (accounts) {
							sender = accounts[tx.senderId];
						});
					});

					it('should not modify tx_id', function () {
						expect(sender_before.tx_id).to.equal(sender.tx_id);
					});

					it('should substract balance', function () {
						sender_before.balance = new bignum(sender_before.balance).minus(tx.amount).minus(tx.fee).toString();
						expect(sender_before.balance).to.equal(sender.balance);
					});

					it('should set pk, pk_tx_id', function () {
						expect(sender.pk).to.equal(tx.senderPublicKey);
						expect(sender.pk_tx_id).to.equal(tx.id);
					});

					it('should not set second_pk', function () {
						expect(sender.second_pk).to.be.null;
					});
				});

				describe('recipient', function () {
					var recipient, tx;

					before(function () {
						tx = transactions[0];
						return getAccountByAddress(tx.recipientId).then(function (accounts) {
							recipient = accounts[tx.recipientId];
						});
					});

					it('should create account', function () {
						expect(recipient.address).to.be.equal(tx.recipientId);
					});

					it('should set tx_id', function () {
						expect(recipient.tx_id).to.be.equal(tx.id);
					});

					it('should not set pk, pk_tx_id, second_pk', function () {
						expect(recipient.pk).to.be.null;
						expect(recipient.pk_tx_id).to.be.null;
						expect(recipient.second_pk).to.be.null;
					});

					it('should credit balance', function () {
						expect(recipient.balance).to.equal(tx.amount.toString());
					});
				});
			});
		});
	});
});