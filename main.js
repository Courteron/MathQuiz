// server.js
require('dotenv').config({ override: true });
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

const app = express();
const port = 8080;


app.use('/', express.static('server'));
app.use('/assets', express.static('assets'));


const server = http.createServer(app);

const wss = new WebSocketServer({ server });
wss.on('error', (err) => console.error('Erreur WebSocketServer:', err.message));

const connections = new Map();


const games = new Map();

// Anciens codes de partie régénérés : un pseudo tentant de rejoindre avec un
// code retiré doit être clairement rejeté, pas silencieusement recréer une
// partie fantôme via getOrCreateGame.
const retiredGameIds = new Set();

function getGame(gameId) {
  return games.get(gameId);
}

function generateGameId() {
  // Alphabet sans caractères ambigus (I/1, O/0).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = '';
    for (let i = 0; i < 6; i++) {
      id += alphabet[crypto.randomInt(alphabet.length)];
    }
  } while (games.has(id));
  return id;
}

// Change l'identifiant public (le "code") d'une partie déjà en cours, sans
// toucher aux connexions WebSocket existantes : master et joueurs déjà
// connectés continuent normalement, seul le code que de NOUVEAUX joueurs
// doivent fournir pour rejoindre change.
function regenerateGameId(game, oldGameId) {
  const newGameId = generateGameId();
  games.delete(oldGameId);
  games.set(newGameId, game);
  retiredGameIds.add(oldGameId);

  const masterInfo = connections.get(game.masterWs);
  if (masterInfo) masterInfo.gameId = newGameId;
  for (const clientInfo of game.clients.values()) {
    clientInfo.gameId = newGameId;
  }

  console.log(`Partie ${oldGameId} renommée en ${newGameId} (régénération du code)`);
  return newGameId;
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

  // Sans ce handler, une erreur socket (coupure réseau brutale, etc.) fait
  // planter tout le process Node (EventEmitter 'error' non écouté).
  ws.on('error', (err) => {
    console.error(`Erreur WebSocket (${id}):`, err.message);
  });

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
        // Idempotent : évite un double broadcast si le master déclenche
        // end_game deux fois (ex: check réactif + minuteur de sécurité).
        if (!game.gameStarted) return;
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
        if (!data.pseudo || !data.pseudo.trim()) {
          send(ws, { type: 'error', message: 'pseudo ne peut pas être vide.' });
          return;
        }

        if (retiredGameIds.has(data.game_id)) {
          send(ws, { type: 'invalid_code' });
          return;
        }

        const game = getOrCreateGame(data.game_id);

        const pseudoTaken = [...game.clients.values()].some(
          (c) => c.pseudo === data.pseudo && c.id !== info.id
        );
        if (pseudoTaken) {
          send(ws, { type: 'pseudo_taken', pseudo: data.pseudo });
          return;
        }

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

      case 'ban_player': {
        const game = getGame(info.gameId);
        if (!game || ws !== game.masterWs) {
          send(ws, { type: 'error', message: 'Seul le maître de cette partie peut bannir un joueur.' });
          return;
        }
        if (!data.pseudo) {
          send(ws, { type: 'error', message: 'ban_player nécessite pseudo.' });
          return;
        }

        console.log(`[${info.gameId}] Joueur banni : ${data.pseudo}`);

        for (const [clientWs, clientInfo] of game.clients) {
          if (clientInfo.pseudo === data.pseudo) {
            send(clientWs, { type: 'banned', pseudo: data.pseudo });
            clientWs.close();
          }
        }

        // Un pseudo banni ne suffit pas si le joueur peut revenir sous un
        // autre nom : on régénère aussi le code de la partie, sans toucher
        // aux joueurs déjà connectés.
        const oldGameIdBan = info.gameId;
        const newGameIdBan = regenerateGameId(game, oldGameIdBan);
        send(ws, { type: 'code_regenerated', old_game_id: oldGameIdBan, new_game_id: newGameIdBan });
        break;
      }

      case 'regenerate_code': {
        const game = getGame(info.gameId);
        if (!game || ws !== game.masterWs) {
          send(ws, { type: 'error', message: 'Seul le maître de cette partie peut régénérer le code.' });
          return;
        }
        const oldGameId = info.gameId;
        const newGameId = regenerateGameId(game, oldGameId);
        send(ws, { type: 'code_regenerated', old_game_id: oldGameId, new_game_id: newGameId });
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
// Démarrage du serveur + tunnel ngrok (binaire ngrok du PATH,
// piloté via l'API locale http://127.0.0.1:4040/api/tunnels)
// ---------------------------------------------------------------

function fetchNgrokUrl(retries = 20) {
    return new Promise((resolve, reject) => {
        const attempt = (remaining) => {
            http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        const tunnel = data.tunnels.find((t) => t.proto === 'https') || data.tunnels[0];
                        if (!tunnel) throw new Error('Aucun tunnel actif');
                        resolve(tunnel.public_url);
                    } catch (err) {
                        if (remaining <= 0) return reject(err);
                        setTimeout(() => attempt(remaining - 1), 500);
                    }
                });
            }).on('error', (err) => {
                if (remaining <= 0) return reject(err);
                setTimeout(() => attempt(remaining - 1), 500);
            });
        };
        attempt(retries);
    });
}

server.listen(port, async () => {
    console.log(`Serveur démarré sur http://localhost:${port}`);

    if (!process.env.NGROK_AUTHTOKEN) {
        console.warn('NGROK_AUTHTOKEN non défini (.env) : tunnel ngrok non démarré.');
        return;
    }

    const ngrokProcess = spawn('ngrok', [
        'http', String(port),
        `--authtoken=${process.env.NGROK_AUTHTOKEN}`,
        '--log=stdout',
    ]);

    ngrokProcess.on('error', (err) => {
        console.error('Impossible de lancer ngrok (binaire absent du PATH ?) :', err.message);
    });
    ngrokProcess.stdout.on('data', (data) => console.log(`ngrok: ${data}`.trim()));
    ngrokProcess.stderr.on('data', (data) => console.error(`ngrok: ${data}`.trim()));

    try {
        const url = await fetchNgrokUrl();
        console.log(`URL ngrok: ${url}`);
    } catch (error) {
        console.error('Erreur ngrok:', error.message);
    }
});

process.on('uncaughtException', (err) => {
    console.error('Erreur non capturée:', err);
    process.exit(1);
});

process.on('unhandledRejection', (err) => {
    console.error('Promesse non gérée:', err);
});