
var redis = require('redis');
var fs = require('fs');


var HOST = "192.168.1.83";
var PORT = "6379";

var client = redis.createClient(PORT, HOST);



client.on('connect', function(err, reply){



	console.log("connected to redis server");

	if(err){
		throw err;
	}


})






function getthething(){
client.hgetall('players', function (err, dbset) {

    var names = [];
    var scores =[];

    var obj = {}

    for(i in dbset) {
    // console.log (i, dbset[i])

    names.push(i);
    scores.push(parseInt(dbset[i]));


    }


    var namescoresBegin = '{"namescores":[';
    var namescoresMiddle = '';
    var namescoresEnd = ']}';

for (var i = 0; i < names.length; i++) {
    if (i<names.length-1){
         namescoresMiddle = namescoresMiddle+'{"name":"'+names[i]+'","score":"'+scores[i]+'"},';
    }else{
        namescoresMiddle = namescoresMiddle+'{"name":"'+names[i]+'","score":"'+scores[i]+'"}';
    }
}

    //var asJSON = JSON.stringify(obj);
    var namescoresFull = namescoresBegin+namescoresMiddle+namescoresEnd;

    fs.writeFile("namescores.json", namescoresFull, function(err) {
    if(err) {
        return console.log(err);
    }
});
}); 
console.log("got the stuff");
setTimeout( getthething, 5000 );

}

getthething();





