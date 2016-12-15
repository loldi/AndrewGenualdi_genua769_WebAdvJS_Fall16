
	function writeTop10(){
		$.getJSON("/js/namescores.json", function(json) {
			for(i=0; i<10; i++){
				var newElement = document.createElement('div');
				var unitNum = 1;
				if (!(i%2)){
					unitNum=2;
				}
				j=i+1;
				var name = json.namescores[i].name;
				var score = json.namescores[i].score;
				newElement.innerHTML = '<div id = "scoreUnit'+unitNum+'" class="inline"><div id= "user" class="inline">'+j+'. '+name+'</div><div id= "score" class="inline">'+score+'</div></div>';
				document.getElementById("scoreboard").appendChild(newElement);
			}
		})
	}

	writeTop10();


