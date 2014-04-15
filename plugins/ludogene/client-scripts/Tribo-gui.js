(function(){

	if (typeof Snap === 'undefined') return; // this file is part of the big minified file imported in all miaou pages, even the ones not importing snap-svg
	
	var T = 10, // size of the board in cells (not expected to change)
		CS = 20, // size of a cell in pixels
		BR = CS/2-2, // radius of a board dot
		bg = Snap.hsb(.5, .4, .5);
	
	function Panel(m, g, s, availableWidth){
		this.m = m;
		this.g = g; // game
		this.s = s; // snap thing
		this.u = -1; // user index in the game
		this.colors = ['SandyBrown', 'AntiqueWhite'], 
		this.grads = this.colors.map(function(c){ return s.gradient("r(0.3,0.3,1)"+c+"-(0,0,0)") });
		g.players.forEach(function(p,i){ if (p.id===me.id) this.u=i }, this);
		this.holeGrad = s.gradient("r(0.3,0.3,1)rgba(0,0,0,0.5)-"+bg);
		if (availableWidth>400) {
			this.layout = "row";
			this.W = 400; // width of the whole drawed area
			this.H = 215; // height of the whole drawed area
			this.XB = (this.W - T*CS); // X of the board
			this.RS = this.XB - 15; // right of the scores
			this.YB = (this.H - T*CS)/2;
			this.XS = 20;
		} else {
			// column layout's reason d'etre is the mobile version of miaou
			this.layout = "column";
			this.W = T*CS;
			this.W += Math.min(10, availableWidth-this.W);
			this.H = 280;
			this.XB = (this.W - T*CS);
			this.RS = this.W - 15;
			this.YB = 70;
			this.XS = this.XB+15;
		}
	}

	Panel.prototype.buildBoard = function(){
		this.holes = [];
		for (var i=0; i<T; i++) this.holes[i] = [];
	}
	
	Panel.prototype.lineMark = function(line, p){
		return this.s.rect(
			this.XB+line.x*CS, this.YB+line.y*CS,
			line.d==='v' ? CS : CS*3,
			line.d==='h' ? CS : CS*3,
			CS/2, CS/2
		).attr({fill:this.colors[p], fillOpacity:0.6}).prependTo(this.s);
	}	
	
	Panel.prototype.drawBoard = function(){
		var panel = this, s = this.s, cells = this.g.cells, XB = this.XB, YB = this.YB,
			userIsCurrentPlayer = panel.g.current!==-1 && panel.u===panel.g.current;
		for (var i=0; i<T; i++) {
			for (var j=0; j<T; j++) {
				(function(i,j){
					if (panel.holes[i][j]) panel.holes[i][j].remove();
					var cell = cells[i][j],
						c = panel.holes[i][j] = s.circle(XB+i*CS+CS/2, YB+j*CS+CS/2, BR);
					if (cell===-1) {
						c.attr({fill: panel.holeGrad});	
						var zone = panel.g.cellZone[i][j];
						if (zone && zone.owner!==undefined) {
							c = s.group(c, s.circle(XB+i*CS+(CS+1)/2, YB+j*CS+(CS+1)/2, BR/2).attr({fill: panel.grads[zone.owner]}));
						}
						if (userIsCurrentPlayer) {
							if (Tribo.canPlay(panel.g, i, j, panel.u)) {
								var lines = Tribo.getLines(panel.g, i, j, panel.u) || [], lineMarks;
								// TODO point lines of 3
								c.attr({cursor:'pointer'}).hover(
									function(){
										c.attr({fill: panel.colors[panel.u]});
										lineMarks = lines.map(function(line){ return panel.lineMark(line, panel.u) });
									},
									function(){
										c.attr({fill: panel.holeGrad});
										lineMarks.forEach(function(line){ line.remove() });
									}
								).click(function(){
									miaou.socket.emit('ludo.move', {mid:panel.m.id, move:Tribo.encodeMove({p:panel.u, x:i, y:j})});
								});
							} else {
								// TODO show why cell isn't playable in a bubble
								// TODO red cross
								c.hover(
									function(){ c.attr({fill: 'red'}) },
									function(){	c.attr({fill: panel.holeGrad}) }
								).click(function(){
									miaou.socket.emit('ludo.move', {mid:panel.m.id, move:Tribo.encodeMove({p:panel.u, x:i, y:j})});
								});
							}
						}
					} else {
						c.attr({fill:panel.grads[cell]});
					}
				})(i,j);
			}
		}
	}
	
	Panel.prototype.buildScores = function(){
		var panel = this, s = panel.s, XS = this.XS, RS = this.RS;
		panel.names = panel.g.players.map(function(player, i){
			return s.text(XS, 28*(i+1), player.name).attr({
				fill: panel.colors[i],
				fontWeight: 'bold'
			})
		});
		panel.scores = panel.g.players.map(function(player, i){
			return s.text(RS, 28*(i+1), '0').attr({
				fill: panel.colors[i],
				fontWeight: 'bold', textAnchor: 'end'
			})
		});
	}

	Panel.prototype.drawScores = function(){
		// Q : what's the proper way to do this using snapsvg ?
		this.scores[0].node.innerHTML = (this.g.scores[0]);
		this.scores[1].node.innerHTML = (this.g.scores[1]);
		if (this.currentPlayerMark) this.currentPlayerMark.remove();
		if (this.g.current >= 0) {
			this.currentPlayerMark = this.s.text(this.XS-15, 28*this.g.current+28, "►").attr({
				fill: this.grads[this.g.current], fontWeight: 'bold'
			})
		} else {
			this.currentPlayerMark = this.s.text(this.XS-18, 28*(this.g.scores[1]>this.g.scores[0])+28, "♛").attr({
				fill: "Goldenrod", fontWeight: 'bold', fontSize: "140%"
			})
		}
	}

	if (!miaou.games) miaou.games = {};
	miaou.games.Tribo = {
		render: function($c, m, g){
			Tribo.restore(g);
			$c.empty().css('background', bg).closest('.message').removeClass('edited');
			var id = 'ludo_'+m.id
				$s = $('<svg id='+id+'></svg>').appendTo($c),
				s = Snap('#'+id), // <- there's probably something cleaner when you have the element, I don't know snapsvg well enough
				p = new Panel(m, g, s, $c.width());
			$s.width(p.W).height(p.H);
			$c.data('tribo-panel', p);
			if (g.status !== "ask") m.locked = true;
			p.buildBoard();
			p.drawBoard();
			p.buildScores();
			p.drawScores();
		},
		move: function($c, m, _, move){
			var panel = $c.data('tribo-panel');
			m.locked = true;
			panel.g.moves += Tribo.encodeMove(move);
			Tribo.apply(panel.g, move);
			panel.drawBoard();
			panel.drawScores();
			if (move.lines) {
				move.lines.forEach(function(line){
					var lm = panel.lineMark(line, move.p).animate({fillOpacity:0}, 6000, mina.linear, function(){
						lm.remove();
					});
				});
			}
		}
	}

})();
