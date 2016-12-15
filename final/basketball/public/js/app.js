		var redis = require('redis');
		var app = redis();

		var HOST = "192.168.1.83";
		var PORT = "6379";

		app.createClient(PORT,HOST);

		var names = [];
		var scores = [];

		app.on('connect', function(err, reply){
			console.log('You did it.');

			if(err){
				throw err;
			}
		})

		app.hgetall('players', function (err, dbset){
			for(i in dbset){
				names.push(i);
				scores.push(parseInt(dbset[i]));
			}
		})