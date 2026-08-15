// server.js
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const port = 8080;


app.use('/', express.static('server'));
app.use('/assets', express.static('assets'));


const server = http.createServer(app);

const wss = new WebSocketServer({ server });

const connections = new Map();


const games = new Map();

function getGame(gameId) {
  return games.get(gameId);
}

function getOrCreateGame(gameId) {
  let game = games.get(gameId);
  if (!game) {
    game = {
      masterWs: null,
      gameStarted: false,
      clients: new Map(),
      currentQuestions: new Map(),
    };
    games.set(gameId, game);
    console.log(`Nouvelle partie créée : ${gameId}`);
  }
  return game;
}

// Supprime une partie si elle n'a plus ni master ni client, pour éviter
// d'accumuler des parties fantômes en mémoire.
function cleanupGameIfEmpty(gameId) {
  const game = games.get(gameId);
  if (game && !game.masterWs && game.clients.size === 0) {
    games.delete(gameId);
    console.log(`Partie ${gameId} vidée, suppression.`);
  }
}

// ---------------------------------------------------------------
// Helpers d'envoi
// ---------------------------------------------------------------

function send(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendToMaster(game, payload) {
  if (game) send(game.masterWs, payload);
}

function broadcastToSingleClient(game, pseudo, payload) {
  if (!game) return;
  for (const [ws, info] of game.clients) {
    if (info.pseudo === pseudo) send(ws, payload);
  }
}

function broadcastToClients(game, payload) {
  if (!game) return;
  for (const [ws, info] of game.clients) {
    if (info.role === 'client') send(ws, payload);
  }
}

function publicClientList(game) {
  if (!game) return [];
  return [...game.clients.values()]
    .filter((info) => info.role === 'client')
    .map((info) => ({ id: info.id, pseudo: info.pseudo }));
}

function publicQuestion(q) {
  // Ne jamais renvoyer correctAnswer aux joueurs
  return { id: q.id, to_pseudo: q.to_pseudo, text: q.text, choices: q.choices };
}

// ---------------------------------------------------------------
// Connexions
// ---------------------------------------------------------------

wss.on('connection', (ws) => {
  const id = crypto.randomUUID();
  const meta = { id, gameId: null, pseudo: null, role: null };
  connections.set(ws, meta);
  console.log(`Nouvelle connexion WebSocket (${id})`);

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return; // message non-JSON ignoré
    }

    const info = connections.get(ws);

    switch (data.type) {
      // ---------------- MASTER ----------------

      case 'master_init': {
        if (!data.game_id) {
          send(ws, { type: 'error', message: 'master_init nécessite game_id.' });
          return;
        }

        const game = getOrCreateGame(data.game_id);

        if (game.masterWs && game.masterWs !== ws) {
          send(ws, { type: 'error', message: 'Un maître est déjà connecté pour cette partie.' });
          return;
        }

        game.masterWs = ws;
        info.role = 'master';
        info.gameId = data.game_id;
        console.log(`Master initialisé pour la partie ${data.game_id}`);

        send(ws, {
          type: 'acknowledge',
          role: 'master',
          game_id: data.game_id,
          gameStarted: game.gameStarted,
          clients: publicClientList(game),
        });
        break;
      }

      case 'start_game': {
        const game = getGame(info.gameId);
        if (!game || ws !== game.masterWs) {
          send(ws, { type: 'error', message: 'Seul le maître de cette partie peut la démarrer.' });
          return;
        }
        game.gameStarted = true;
        console.log(`Partie ${info.gameId} démarrée par le master`);
        broadcastToClients(game, {
          type: 'game_started',
          game_id: info.gameId,
          music_id: data.music_id,
        });
        break;
      }

      case 'send_question': {
        const game = getGame(info.gameId);
        if (!game || ws !== game.masterWs) {
          send(ws, { type: 'error', message: 'Seul le maître de cette partie peut envoyer une question.' });
          return;
        }
        if (!data.to_pseudo) {
          send(ws, { type: 'error', message: 'send_question nécessite to_pseudo.' });
          return;
        }

        // La question est stockée PAR JOUEUR, dans la partie concernée.
        const question = {
          id: data.id ?? crypto.randomUUID(),
          text: data.text,
          to_pseudo: data.to_pseudo,
          choices: data.choices,
          correctAnswer: data.correctAnswer,
        };
        game.currentQuestions.set(data.to_pseudo, question);
        console.log(question.choices);
        console.log(`[${info.gameId}] Nouvelle question envoyée à ${data.to_pseudo} : ${question.id}`);
        broadcastToSingleClient(game, data.to_pseudo, { type: 'question', ...publicQuestion(question) });
        break;
      }

      case 'end_game': {
        const game = getGame(info.gameId);
        if (!game || ws !== game.masterWs) {
          send(ws, { type: 'error', message: 'Seul le maître de cette partie peut la terminer.' });
          return;
        }
        game.gameStarted = false;
        game.currentQuestions.clear(); // on vide toutes les questions en cours de CETTE partie
        console.log(`Partie ${info.gameId} terminée par le master`);
        broadcastToClients(game, { type: 'game_ended', game_id: info.gameId, scores:data.scores });
        break;
      }

      // ---------------- CLIENTS ----------------

      case 'pseudo': {
        if (!data.game_id) {
          send(ws, { type: 'error', message: 'pseudo nécessite game_id.' });
          return;
        }

        const game = getOrCreateGame(data.game_id);

        info.pseudo = data.pseudo;
        info.gameId = data.game_id;
        if (!info.role) info.role = 'client';
        game.clients.set(ws, info);

        console.log(`[${data.game_id}] Pseudo enregistré : ${data.pseudo} (${info.id})`);

        send(ws, {
          type: 'acknowledge',
          role: 'client',
          game_id: data.game_id,
          gameStarted: game.gameStarted,
        });

        // Le master de CETTE partie est informé de chaque arrivée de joueur
        sendToMaster(game, { type: 'client_joined', id: info.id, pseudo: info.pseudo });
        console.log(`Client ${info.pseudo} (${info.id}) a rejoint la partie ${data.game_id} - Master prévenu.`);
        break;
      }

      case 'answer': {
        const game = getGame(info.gameId);
        if (!info.pseudo || !game) {
          send(ws, { type: 'error', message: 'Pseudo/partie non définis pour cette connexion.' });
          return;
        }

        const myQuestion = game.currentQuestions.get(info.pseudo);

        if (!myQuestion || data.id !== myQuestion.id) {
          send(ws, { type: 'error', message: 'Aucune question active pour cet identifiant.' });
          console.log("No active question for answer id :" + data.id);
          console.log("Pseudo : " + info.pseudo);
          return;
        }

        const isCorrect = data.answer === myQuestion.correctAnswer;
        send(ws, {
          type: 'answer_ack',
          correct: isCorrect,
          correctAnswer: myQuestion.correctAnswer,
        });

        // On retire la question répondue : le joueur ne peut plus y répondre deux fois
        // et il faudra que le master lui en envoie une nouvelle pour continuer.
        game.currentQuestions.delete(info.pseudo);

        // Le master de CETTE partie voit les réponses arriver en temps réel
        console.log("Sending to master answer for pseudo : " + info.pseudo);
        sendToMaster(game, {
          type: 'player_answered',
          id: info.id,
          pseudo: info.pseudo,
          answer: data.answer,
          correct: isCorrect,
        });
        break;
      }

      case 'percent_info': {
        const game = getGame(info.gameId);
        if (!game || ws !== game.masterWs) {
          send(ws, { type: 'error', message: 'Seul le maître de cette partie peut envoyer les pourcentages.' });
          return;
        }
        broadcastToSingleClient(game, data.to_pseudo, {
          type: 'percent_info',
          to_pseudo: data.to_pseudo,
          percent: data.percent,
        });
        break;
      }

      default:
        console.warn('Type de message inconnu reçu :', data.type);
    }
  });

  ws.on('close', () => {
    const info = connections.get(ws);
    connections.delete(ws);

    if (!info) return;

    const game = getGame(info.gameId);

    if (game && ws === game.masterWs) {
      game.masterWs = null;
      console.log(`Master de la partie ${info.gameId} déconnecté`);
      broadcastToClients(game, { type: 'master_disconnected' });
      cleanupGameIfEmpty(info.gameId);
      return;
    }

    console.log(`Déconnexion : ${info.pseudo ?? 'inconnu'} (${info.id}) [partie ${info.gameId ?? 'aucune'}]`);
    if (game && info.role === 'client') {
      game.clients.delete(ws);
      game.currentQuestions.delete(info.pseudo); // nettoyage de sa question en cours
      sendToMaster(game, { type: 'client_left', id: info.id, pseudo: info.pseudo });
      cleanupGameIfEmpty(info.gameId);
    }
  });
});

// ---------------------------------------------------------------
// Démarrage du serveur (inchangé, y compris le lancement de ngrok)
// ---------------------------------------------------------------

server.listen(port, () => {
    console.log(`Serveur démarré sur http://localhost:${port}`);

    const ngrokPath = 'C:\\Users\\Louis\\AppData\\Local\\Microsoft\\WindowsApps\\ngrok.exe';
    const ngrokProcess = exec(`${ngrokPath} http ${port}`, (error, stdout, stderr) => {
        if (error) { console.error('Erreur ngrok:', error.message); return; }
        if (stderr) { console.error('Erreur ngrok (stderr):', stderr); return; }
        console.log('URL ngrok:', stdout);
    });

    ngrokProcess.stdout.on('data', (data) => console.log(`ngrok: ${data}`));
    ngrokProcess.stderr.on('data', (data) => console.error(`ngrok stderr: ${data}`));
});

process.on('uncaughtException', (err) => {
    console.error('Erreur non capturée:', err);
    process.exit(1);
});

process.on('unhandledRejection', (err) => {
    console.error('Promesse non gérée:', err);
});