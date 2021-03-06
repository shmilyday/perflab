'use strict';

let Promise = require('bluebird'),
	MongoClient = require('mongodb');

// map-reduce functions for calculating statistics on test runs
//
// NB: below functions must use Mongo JS compatible syntax
//     as they are serialised and sent to the Mongo server.
//
function test_stats_map() {
	if (counter++ > 0) {
		emit(this.run_id, {
			sum: this.count, // the field you want stats for
			min: this.count,
			max: this.count,
			count: 1,
			diff: 0
		});
	}
}

function test_stats_reduce(key, values) {
	return values.reduce(function reduce(previous, current, index, array) {
		var delta = previous.sum/previous.count - current.sum/current.count;
		var weight = (previous.count * current.count)/(previous.count + current.count);

		return {
			sum: previous.sum + current.sum,
			min: Math.min(previous.min, current.min),
			max: Math.max(previous.max, current.max),
			count: previous.count + current.count,
			diff: previous.diff + current.diff + delta*delta*weight
		};
	})
}

function test_stats_finalize(key, value) { 
	if (value.count > 1) {
		var variance = value.diff / (value.count - 1);
		value.stddev = Math.sqrt(variance);
	}
	if (value.count > 0) {
		value.average = value.sum / value.count;
	}
	delete value.sum;
	delete value.diff;
	++value.count;
	return value;
}

//
// wrapper class for all database access methods
//
class Database {
	constructor (settings) {

		Promise.longStackTraces();

		let dbp = MongoClient.connect(settings.url, {promiseLibrary: Promise});

		let ObjectID = MongoClient.ObjectID;
		let oid = (id) => (id instanceof ObjectID) ? id : ObjectID.createFromHexString(id);

		// simply wrapper for DB, extracting the db handle from the dbp promise
		let query = this.query = (f) => dbp.then((db) => f.call(this, db));

		this.close = () => dbp.then(db => db.close());

		// build required indexes
		this.createIndexes = () =>
			query((db) => Promise.all([
				db.collection('run').createIndex({config_id: 1, created: -1}),
				db.collection('test').createIndex({run_id: 1, created: 1}),
				db.collection('memory').createIndex({run_id: 1, created: 1})
			]));

		// 'obj' must contain {"enabled": <boolean>}
		// disabling the entry also disables auto-repeat
		this.setQueueEntryEnabled = (id, obj) =>
			query((db) => {
				var set = {
					'queue.enabled': !!obj.enabled
				};
				if (!obj.enabled) {
					set['queue.repeat'] = false;
				}
				return db.collection('config').updateOne({_id: oid(id)}, {$set: set});
			});

		// returns {"enabled": <boolean>}
		this.getQueueEntryEnabled = (id) =>
			query((db) => db.collection('config')
					.findOne({_id: oid(id) })
					.then((r) => r ? { enabled: !!r.queue.enabled } : {enabled: false}));

		// 'obj' must contain {"repeat": <boolean>}
		// job always get enabled at the same time
		this.setQueueEntryRepeat = (id, obj) =>
			query((db) => {
				var set = {'queue.repeat': !!obj.repeat };
				set['queue.enabled'] = true;
				return db.collection('config').updateOne({_id: oid(id)}, {$set: set});
			});

		// returns {"repeat": <boolean>}
		this.getQueueEntryRepeat = (id) =>
			query((db) => db.collection('config')
					.findOne({_id: oid(id) })
					.then((r) => r ? { repeat: !!r.queue.repeat } : {repeat: false}));

		// 'obj' must contain {"priority": <number>}
		this.setQueueEntryPriority = (id, obj) =>
			query((db) => db.collection('config')
					.updateOne({_id: oid(id)}, {$set: {'queue.priority': obj.priority}}));

		// sets a text label showing the queued entry's state
		this.setQueueState = (id, label) =>
			query((db) => db.collection('config')
					.updateOne({_id: oid(id)}, {$set: {'queue.state': label}}));

		// atomically finds the oldest non-running entry in
		// the queue, marks it as running and returns it
		this.takeNextFromQueue = (filter) =>
			query((db) => db.collection('config')
					.findOneAndUpdate(
						{$and: [filter, {'queue.running': {$ne: true}, 'queue.enabled': true, 'deleted': {$ne: true}}]},
						{$set: {
							'queue.running': true,
							'queue.started': new Date()
						}},
						{sort: {'queue.priority': -1, 'queue.completed': 1}}
					)).then((res) => res.value);

		// mark all jobs as stopped
		this.clearQueue = (filter) =>
			query((db) => db.collection('config')
					.update(
						{$and: [filter, {'queue.running': true} ]},
						{$set: { 'queue.running' : false }},
						{multi: true}
					));

		// sets the queue entry to "non-running" and updates the
		// "last completed" field, and resets its priority
		this.markQueueEntryDone = (id) =>
			query((db) => {
				return db.collection('config')
					.updateOne({_id: oid(id)},
							{$set: {
								'queue.running': false,
								'queue.priority': 0,
								'queue.completed': new Date()
							}})
			});

		// atomically disables the given entry if it's not
		// set to auto-repeat
		this.disableOneshotQueue = (id) =>
			query((db) => db.collection('config')
					.findOneAndUpdate(
						{_id: oid(id), 'queue.repeat': {$ne: true}},
						{$set: {'queue.enabled': false}}
					)).then((res) => res.value);


		// retrieve the specified configuration
		this.getConfigById = (id) =>
			query((db) => db.collection('config')
					.findOne({_id: oid(id)}));

		// deletes the specified configuration (not really)
		this.deleteConfigById = (id) =>
				query((db) => db.collection('config')
					.updateOne({_id: oid(id)}, {$set: {deleted: true}}));

		// updates the configuration with the given block, taking
		// care to update the 'updated' field and not to modify the
		// 'created' field or the queue settings.  NB: other fields
		// not in 'config' are left unmodified
		this.updateConfig = (id, config) =>
			query((db) => {
				config._id = oid(config._id);
				config.updated = new Date();
				delete config.created;
				delete config.queue;
				return db.collection('config')
					.updateOne({_id: config._id}, {$set: config});
			});

		// store a new configuration in the database, automatically
		// setting the 'created' and 'updated' fields to 'now'
		this.insertConfig = (config) =>
			query((db) => {
				config.created = new Date();
				config.updated = new Date();
				config.queue = {
					enabled: true, repeat: true, priority: 0
				};
				return db.collection('config')
					.insert(config).then(() => config);
			});

		// retrieve all configurations
		this.getConfigs = () =>
			query((db) => db.collection('config')
				.find({deleted: {$ne: true}})
				.sort({name: 1})
				.toArray());

		// store a new daemon run in the database, automatically
		// setting the 'created' and 'updated' fields to 'now'
		this.insertRun = (run) =>
			query((db) => {
				run.created = new Date();
				run.updated = new Date();
				return db.collection('run')
					.insert(run).then(() => run);
			});

		// retrieve the specified run entry
		this.getRunById = (id) =>
			query((db) => db.collection('run').findOne({_id: oid(id)}));

		// updates the run with the given data block.  NB: other
		// fields not in 'data' are left unmodified
		this.updateRunById = (id, data) =>
			query((db) => {
				data.updated = new Date();
				return db.collection('run')
					.update({_id: oid(id)}, {$set: data});
			});

		// finds all 'test' entries for the given run and uses an
		// in-memory mapReduce function to generate statistics for that
		// run
		this.updateStatsByRunId = (run_id) =>
			query((db) => db.collection('test')
				.mapReduce(test_stats_map, test_stats_reduce, {
					scope: { counter: 0 },
					finalize: test_stats_finalize,
					query: { run_id: oid(run_id) },
					out: { inline: 1 },
				}).then((mr) => {
					mr = mr.results || mr || [];
					if (mr.length === 0) {
						return { count: 1 };
					} else {
						return mr[0].value;
					}
				}).then((stats) => db.collection('run').update(
					{_id: oid(run_id)},
					{$set: { stats }}
				)));

		// stores raw memory usage statistics associated with a run
		this.insertMemoryStats = (memory) =>
			query((db) => {
				memory.ts = new Date();
				return db.collection('memory').insert(memory);
			});

		// gets all memory usage statistics associated with a run
		this.getMemoryStatsByRunId = (run_id, mem) =>
			query((db) => db.collection('memory')
				.find({run_id: oid(run_id)}, {ts:1, data: 1, _id: 0})
				.sort({ts: 1})
				.toArray());

		// store a new daemon run in the database, automatically
		// setting the 'created' and 'updated' fields to 'now'
		this.insertTest = (test) =>
			query((db) => {
				test.created = new Date();
				test.updated = new Date();
				return db.collection('test')
					.insert(test).then(() => test);
			});

		// updates the test with the given block, taking
		// care to update the 'updated' field and not to modify the
		// 'created' field.  NB: other fields not in 'data' are left
		// unmodified
		this.updateTestById = (id, data) =>
			query((db) => {
				data.updated = new Date();
				delete data.created;
				return db.collection('test')
					.update({_id: oid(id)}, {$set: data});
			});

		// get all runs for the given config in reverse order,
		// optionally paginated
		this.getRunsByConfigId = (config_id, skip, limit) =>
			query((db) => {
				skip = skip || 0;
				limit = limit || 0;
				config_id = oid(config_id);
				return db.collection('run')
					.find({config_id}, {stdout: 0, stderr: 0})
					.sort({created: -1})
					.skip(skip).limit(limit)
					.toArray();
			});

		// get all tests for the given run, in time order
		this.getTestsByRunId = (run_id) =>
			query((db) => {
				run_id = oid(run_id);
				return db.collection('test')
					.find({run_id}, {stdout: 0, stderr: 0})
					.sort({created: 1})
					.toArray();
			});

		// get a specific test result
		this.getTestById = (id) =>
			query((db) => db.collection('test')
					.findOne({_id: oid(id)}));

		// get the global control object
		this.getControl = (obj) =>
			query((db) => db.collection('control').findOne());

		// set the global paused status
		// 'obj' must contain {"paused": <boolean>}
		this.setPaused = (obj) =>
			query((db) => db.collection('control')
					.updateOne({}, {$set: {paused: !!obj.paused}}, {upsert: true}));

		// get the global paused status
		// return will be {"paused": <boolean>}
		this.getPaused = () =>
			query((db) => db.collection('control')
					.findOne({paused: {$exists: 1}}, {paused: 1, _id: 0})
					.then((r) => r || {paused: false}));

		// store a single log entry
		this.insertLog = (log) =>
			query((db) => db.collection('log').insert(log));

		// get all log entries
		this.getLog = () =>
			query((db) => db.collection('log').find().toArray());
	}
}

module.exports = Database;
