// server.js
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const port = 8080;

// Middlewares pour les fichiers statiques (inchangé)
app.use('/', express.static('server'));
app.use('/assets', express.static('assets'));

// Créer le serveur HTTP (inchangé)
const server = http.createServer(app);

// --- WebSocket branché sur le MÊME serveur HTTP / MÊME port ---
const wss = new WebSocketServer({ server });

// ---------------------------------------------------------------
// État de la partie
// ---------------------------------------------------------------

// Une seule connexion "maître" à la fois. Les autres sont des "clients".
let masterWs = null;

// ws -> { id, pseudo, role: 'client' | 'master' | null }
const clients = new Map();

let gameStarted = false;

// NOUVEAU : chaque joueur a SA propre question courante.
// clé = pseudo, valeur = { id, text, choices, correctAnswer }
const currentQuestions = new Map();

// ---------------------------------------------------------------
// Helpers d'envoi
// ---------------------------------------------------------------

function send(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendToMaster(payload) {
  send(masterWs, payload);
}

function broadcastToSingleClients(payload) {
  for (const [ws, info] of clients) {
    if (info.pseudo === payload.to_pseudo) send(ws, payload);
  }
}
function broadcastToClients(payload) {
  for (const [ws, info] of clients) {
    if (info.role === 'client') send(ws, payload);
  }
}
function publicClientList() {
  return [...clients.values()]
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
  clients.set(ws, { id, pseudo: null, role: null });
  console.log(`Nouvelle connexion WebSocket (${id})`);

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return; // message non-JSON ignoré
    }

    const info = clients.get(ws);

    switch (data.type) {
      // ---------------- MASTER ----------------

      case 'master_init': {
        if (masterWs && masterWs !== ws) {
          send(ws, { type: 'error', message: 'Un maître est déjà connecté.' });
          return;
        }
        masterWs = ws;
        info.role = 'master';
        console.log('Master initialisé');

        send(ws, {
          type: 'acknowledge',
          role: 'master',
          gameStarted,
          clients: publicClientList(),
        });
        break;
      }

      case 'start_game': {
        if (ws !== masterWs) {
          send(ws, { type: 'error', message: 'Seul le maître peut démarrer la partie.' });
          return;
        }
        gameStarted = true;
        console.log('Partie démarrée par le master');
        broadcastToClients({ type: 'game_started',music_id:data.music_id});
        break;
      }

      case 'send_question': {
        if (ws !== masterWs) {
          send(ws, { type: 'error', message: 'Seul le maître peut envoyer une question.' });
          return;
        }
        if (!data.to_pseudo) {
          send(ws, { type: 'error', message: 'send_question nécessite to_pseudo.' });
          return;
        }

        // NOUVEAU : la question est stockée PAR JOUEUR, plus dans une variable globale.
        const question = {
          id: data.id ?? crypto.randomUUID(),
          text: data.text,
          to_pseudo: data.to_pseudo,
          choices: data.choices,
          correctAnswer: data.correctAnswer,
        };
        currentQuestions.set(data.to_pseudo, question);

        console.log(`Nouvelle question envoyée à ${data.to_pseudo} : ${question.id}`);
        broadcastToSingleClients({ type: 'question', ...publicQuestion(question) });
        break;
      }

      case 'end_game': {
        if (ws !== masterWs) {
          send(ws, { type: 'error', message: 'Seul le maître peut terminer la partie.' });
          return;
        }
        gameStarted = false;
        currentQuestions.clear(); // NOUVEAU : on vide toutes les questions en cours
        console.log('Partie terminée par le master');
        broadcastToClients({ type: 'game_ended' });
        break;
      }

      // ---------------- CLIENTS ----------------

      case 'pseudo': {
        info.pseudo = data.pseudo;
        if (!info.role) info.role = 'client';
        console.log(`Pseudo enregistré : ${data.pseudo} (${info.id})`);

        send(ws, {
          type: 'acknowledge',
          role: 'client',
          gameStarted,
        });

        // Le master est informé de chaque arrivée de joueur
        sendToMaster({ type: 'client_joined', id: info.id, pseudo: info.pseudo });
        console.log(`Client ${info.pseudo} (${info.id}) a rejoint la partie - Master prévenu.`);
        break;
      }

      case 'answer': {
        // NOUVEAU : on va chercher LA question de CE joueur, pas une variable globale
        if (!info.pseudo) {
          send(ws, { type: 'error', message: 'Pseudo non défini pour cette connexion.' });
          return;
        }

        const myQuestion = currentQuestions.get(info.pseudo);

        if (!myQuestion || data.id !== myQuestion.id) {
          send(ws, { type: 'error', message: 'Aucune question active pour cet identifiant.' });
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
        currentQuestions.delete(info.pseudo);

        // Le master voit les réponses arriver en temps réel, indépendamment des autres joueurs
        sendToMaster({
          type: 'player_answered',
          id: info.id,
          pseudo: info.pseudo,
          answer: data.answer,
          correct: isCorrect,
        });
        break;
      }
      case 'percent_info': {
        if (ws !== masterWs) {
          send(ws, { type: 'error', message: 'Seul le maître peut envoyer les pourcentages.' });
          return;
        }
        broadcastToSingleClients({ type: 'percent_info', to_pseudo: data.to_pseudo, percent: data.percent });
        break;
      }
      default:
        console.warn('Type de message inconnu reçu :', data.type);
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    clients.delete(ws);

    if (ws === masterWs) {
      masterWs = null;
      console.log('Master déconnecté');
      broadcastToClients({ type: 'master_disconnected' });
      return;
    }

    if (info) {
      console.log(`Déconnexion : ${info.pseudo ?? 'inconnu'} (${info.id})`);
      if (info.role === 'client') {
        currentQuestions.delete(info.pseudo); // NOUVEAU : nettoyage de sa question en cours
        sendToMaster({ type: 'client_left', id: info.id, pseudo: info.pseudo });
      }
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