var Xray = require('x-ray');
var x = Xray();

// 1st argument: URL you want to scrape
// 2nd argument: the selector that you want to grab
// 3rd argument: the array containing object of what you want to be passed on
x('http://www.nfl.com/scores/2016/REG5', '#score-boxes', [{
	teamData: x('.new-score-box-wrapper', [{
		date:'.date',
		channel:'.network',
		timeleft:'.time-left',
		awayTeam: x('.away-team', [{
			name: '.team-name',
			logo:'a img@src',
			record: '.team-record',
			points:'.total-score',
		}]),
		homeTeam: x('.home-team', [{
			name: '.team-name',
			logo:'a img@src',
			record: '.team-record',
			points:'.total-score',
		}])
		// poster: x('.lister-item-header a@href', 'head meta[property="og:image"]@content')
	}])
}])
	// .paginate('a.lister-page-next.next-page@href')
	// .limit(20)
     .write('results.json');