$( document ).ready(function(){
   $.ajax({
      url: 'http://www.nfl.com/liveupdate/scorestrip/ss.json',
      data: {
         format: 'json'
      },
      error: function() {
         $('#info').html('<p>An error has occurred</p>');
      },
      dataType: 'json',
      success: function(data) {
    

         var $difference =  data.gms[7].hs - data.gms[7].vs;

         var $giantScore = data.gms[7].hs;
         var $visitorScore = data.gms[7].vs;

         var $quarter = data.gms[7].q;

         var gameTime = data.gms[7].t;

         var day = data.gms[7].d;

         var win;
         
         var stillPlaying;

         var notPlaying;

         if ($quarter == 'F'){
         	stillPlaying = false;
         } else {
         	stillPlaying = true;
         };

         if ($quarter == 'P'){
         	notPlaying = true;
         } else {
         	notPlaing = true;
         };

         var outcome;

         if ($giantScore > $visitorScore)
         {
         	win = true;
         } else {
         	win = false;
         };

         if ($giantScore == $visitorScore && $quarter !='F' && $quarter !='P')
         {
         	$('.answer').append('NO');

         	$('#scoreline').append("They're tied.");

         };


         if (win && !stillPlaying){
         	var outcome = "won";
         	

         } else {
         	var outcome = "lost";
         };

         if ($difference < 0) {
         	$difference = $difference * -1;
         }



         if (win && stillPlaying){
         	var outcome = "are winning";
         } else if (win == false && stillPlaying == true) {
         	var outcome = "are losing";
         };

         if (notPlaying){
         	  $('.answer').append('NO');

         	  $('#scoreline')

        .append("The Giants next game is on " + day + "day at " + gameTime + " P.M. against  the " + data.gms[7].vnn);

         }

       if ($giantScore > $visitorScore && $quarter != 'F'){

     	

      	$('.answer').append('NO');
      	
         $('#scoreline')

        .append("The Giants " + outcome + " by " + $difference);

         };

       if ($giantScore < $visitorScore && $quarter != 'F') {

        $('.answer').append('YES');

           $('#scoreline')

        .append("The Giants " + outcome + " by " + $difference);

       };


       if ($giantScore < $visitorScore && $quarter == 'F') {

       	$('.answer').append('THEY LOST');

       } else if ($giantScore > $visitorScore && $quarter == 'F'){

       	$('.answer').append('THEY WON');
       }

         $('#info')
            // .append($title)
            .append($description)
            .append($score)
            .append($description2)
            .append($score2);
      },
      type: 'GET'
   });
});


