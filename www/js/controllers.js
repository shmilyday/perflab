(function() {

"use strict";

var app = angular.module('perflabApp');

app.controller('logViewController', ['$scope', 'LogWatcher',
	function ($scope, LogWatcher) {

		$scope.logwatch = LogWatcher;

		try {
			$scope.host = JSON.parse(localStorage.loghost);
		} catch (e) {
			$scope.host = '';
		}

		$scope.setHost = function(host) {
			$scope.host = host;
			localStorage.loghost = JSON.stringify(host);
		}

		$scope.hasHosts = function() {
			return Object.keys($scope.logwatch.output || {}).length > 1;
		}

		$scope.setHost($scope.host);
	}
]);

app.controller('configListController',
	['$scope', 'Configs', 'ServerAgentResource',
	function($scope, Configs, ServerAgentResource) {

		$scope.configs = Configs;
		$scope.filter = JSON.parse(localStorage.filter || 'false');

		$scope.toggleFilter = function(val) {
			localStorage.filter = $scope.filter = !$scope.filter;
		}

		$scope.agents = ServerAgentResource.query();

		$scope.setSort = function(sort) {
			if (sort === 'pri') {
				$scope.predicate = [
					'-queue.running',
					'-queue.enabled',
					'-queue.priority',
					'queue.completed'
				];
			} else {
				$scope.predicate = 'name';
			}
			localStorage.sort = $scope.sort = sort;
		}

		// do initial sort
		$scope.setSort(localStorage.sort || "name");
	}
]);

app.controller('systemController',
	['$scope', 'SystemControl',
	function($scope, SystemControl) {
		$scope.control = SystemControl;
	}
]);

app.controller('runListController',
	['$scope', '$route', '$routeParams', '$location',
	 'ConfigResource', 'RunResource', 'TestResource', 'OpLog', 'Notify', 'Stats',
	function($scope, $route, $routeParams, $location,
			 ConfigResource, RunResource, TestResource, OpLog, Notify, Stats) {

		var id = $routeParams.config_id;
		var search = $location.search();
		var skip = +search.skip || 0;
		var limit = +search.limit || 0;
		if (limit <= 0) {
			limit = 15;
		}

		$scope.page = Math.floor(skip / limit) + 1;

		$scope.skipto = function(arg) {
			$location.search(arg);
			$route.reload();
		};

		$scope.getgroup = function(run) {
			return Stats.getgroup(run._id);
		}

		$scope.statsToggle = function(run, group) {
			if (Stats.getgroup(run._id) === group) {
				Stats.del(run._id);
			} else {
				var stats = TestResource.query({run_id: run._id}, function(data) {
					data = data.map(function(d) {
						return d.count;
					});
					data.shift();		// ignore first point
					Stats.setgroup(run._id, data, group);
				}, Notify.danger);
			}
		};

		ConfigResource.get({id: id}, function(config) {
			$scope.config = config;
		}, Notify.danger);

		RunResource.query({config_id: id, skip: skip, limit: limit}, function(runs) {
			$scope.runs = runs;

			var link = {};
			if (skip > 0) {
				link.first = makelink(0, limit);
				link.prev = makelink(Math.max(0, skip - limit), limit);
			}
			if (runs.length >= limit) {
				link.next = makelink(skip + limit, limit);
			}
			$scope.link = link;

		}, Notify.danger);

		function makelink(skip, limit) {
			return "skip=" + skip + "&limit=" + limit;
		}

		OpLog.on('update.run', function(ev, doc) {
			if (doc && doc._id) {
				$scope.runs.forEach(function(run, i, a) {
					if (run._id === doc._id) {
						RunResource.get({id: run._id}, function(data) {
							a[i] = data;
						});
					}
				});
			}
		});

	}
]);

app.controller('testListController',
	['$scope', '$routeParams', 'OpLog', 'TestResource', 'RunResource', 'ConfigResource', 'Notify',
	function($scope, $routeParams, OpLog, TestResource, RunResource, ConfigResource, Notify) {

		var id = $routeParams.run_id;

		TestResource.query({run_id: id}, function(tests) {
			$scope.tests = tests;
		}, Notify.danger);

		RunResource.get({id: id}, function(run) {
			$scope.run = run;
			ConfigResource.get({id: run.config_id}, function(config) {
				$scope.config = config;
			});
		}, Notify.danger);

		OpLog.on('update.run', function(ev, doc) {
			if (doc && (doc._id === id)) {
				TestResource.query({run_id: id}, function(tests) {
					$scope.tests = tests;
				});
			}
		});
	}
]);

app.controller('testDetailController',
	['$scope', '$routeParams', 'TestResource', 'Notify',
	function($scope, $routeParams, TestResource, Notify) {
		TestResource.get({id: $routeParams.test_id}, function(test) {
			$scope.test = test;
		}, Notify.danger);
	}
]);

app.controller('configEditController',
	['$scope', '$http', '$route', '$location', '$routeParams',
	 'Notify', 'RunResource', 'ConfigResource', 'SettingsResource',
	 'ServerAgentResource', 'ClientAgentResource',
	function($scope, $http, $route, $location, $routeParams,
			 Notify, RunResource, ConfigResource, SettingsResource,
			 ServerAgentResource, ClientAgentResource) {

		var id = $scope.id = $routeParams.id;
		$scope.agent = ServerAgentResource.get({agent: $routeParams.type});
		$scope.agent.$promise.then(function(agent) {
			$scope.clients = ClientAgentResource.query({protocol: agent.protocol})
		});
		$scope.type = $routeParams.type;
		$scope.settings = SettingsResource.get();

		if ($scope.id === undefined) {
			if ($routeParams.clone !== undefined) {
				$http.get('/api/config/' + $routeParams.clone).then(function(res) {
					$scope.config = res.data;
					$scope.config.name = 'Clone of ' + $scope.config.name;
					$scope.config.notes = $scope.config.name + ' ' + Date().toString();
					delete $scope.id;
					delete $scope.config._id;
					delete $scope.config.created;
					delete $scope.config.updated;
					$scope.configEdit.$setDirty();
				}).catch(redirectNotify);
			}
			$scope.settings.$promise.then(function() {
				setDefaults();
				$scope.config.type = $scope.type;
			});
		} else {
			$http.get('/api/config/' + $scope.id).then(function(res) {
				$scope.config = res.data;
				$scope.settings.$promise.then(setDefaults);
			}).catch(redirectNotify);

			// just used to check if this config has any results
			RunResource.query({config_id: id, limit: 1}, function(data) {
				$scope.existing = !!(data && data.length);
			}, Notify.danger);
		}

		function redirectNotify(e) {
			Notify.danger(e);
			setTimeout(function() {
				$location.path('/config/');
				$route.reload();
			}, 3000);
		}

		function setDefaults() {
			var config = $scope.config = $scope.config || {};

			config.flags = config.flags || {checkout: false};
			config.wrapper = config.wrapper || [];
			if ($scope.agent.protocol === 'dns' && !config.mode) {
				config.mode = ($scope.agent.subtype && $scope.agent.subtypes[0]) || 'authoritative';
			}

			if (!config.client) {
				config.client = $scope.settings.default_clients[$scope.agent.protocol];
			}

			var args = config.args = config.args || {};
			args.configure = args.configure || [];
			args.make = args.make || [];
			args.server = args.server || [];
			args.tester = args.tester || [];

			config.zoneset = config.zoneset || 'root';
			config.queryset = config.queryset || '';
			config.options = config.options || '';
			config.global = config.global || '';
			config.notes = config.notes || '';
			config.postTest = config.postTest || '';
			config.postRun = config.postRun || '';
		}

		function doneSaving() {
			$scope.saving = false;
		}

		$scope.save = function() {
			$scope.saving = true;
			if ($scope.id === undefined) {
				$http.post('/api/config/', $scope.config).then(function(res) {
					$scope.id = res.data._id;
					$location.path('/config/' + $scope.config.type + '/' + $scope.id + '/edit').replace();
					Notify.info('Saved');
					$route.reload();
				}).catch(Notify.danger).then(doneSaving);
			} else {
				$http.put('/api/config/' + $scope.id, $scope.config).then(function() {
					$scope.configEdit.$setPristine();
					Notify.info('Saved');
				}).catch(Notify.danger).then(doneSaving);
			}
		}

		$scope.delete = function() {
			$scope.saving = true;
			if ($scope.id !== undefined) {
				$http.delete('/api/config/' + $scope.id).then(function(res) {
					redirectNotify('Configuration deleted');
				}).catch(Notify.danger).then(doneSaving);
			}
		}
	}
]);

app.controller('statsController', ['$scope', 'Stats',
	function($scope, Stats) {
		$scope.stats = Stats;

		$scope.open = function() {
			$('#stats').modal();
		}
	}
]);

app.controller('statsResultsController', ['$scope', 'Stats',
	function($scope, Stats) {
		$('#stats').on('show.bs.modal', function() {
			$scope.data = Stats.calculate();
		});
	}
]);

app.controller('beepController', ['$scope', 'Beeper',
	function($scope, Beeper) {
		$scope.beeper = Beeper;
	}
]);

})();
