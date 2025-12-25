const express = require('express');
const multer = require('multer');
const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

const TOKEN = 'YOUR TICKET GOES IN HERE';
const CHANNEL_ID = 'THE CHANNEL YOUR BOT IS GOING TO USE';
const CHUNK_SIZE = 10 * 1024 * 1024; // i guess 10 MB
const DB_PATH = 'db.json';

// create things and folders and shi if they don't exist
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('temp')) fs.mkdirSync('temp');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.login(TOKEN);

client.on('ready', async () => {
  console.log(`Bot connected as ${client.user.tag}`);
  await updateLocalDB();
});

// file handling bs
function splitFile(filePath) {
  const stats = fs.statSync(filePath);
  if (stats.size <= CHUNK_SIZE) return [filePath];

  const buffer = fs.readFileSync(filePath);
  const totalParts = Math.ceil(stats.size / CHUNK_SIZE);
  const chunks = [];

  for (let i = 0; i < totalParts; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, stats.size);
    const chunkPath = `${filePath}.part${i+1}`;
    fs.writeFileSync(chunkPath, buffer.slice(start, end));
    chunks.push(chunkPath);
  }
  return chunks;
}

async function uploadFileInParts(channel, filePath) {
  const parts = splitFile(filePath);
  let lastMessage = null;
  const addedParts = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const partName = parts.length > 1 ? `${path.basename(filePath)}.part${i+1}` : path.basename(filePath);

    const options = { files: [{ attachment: part, name: partName }] };
    if (lastMessage) options.reply = { messageReference: lastMessage.id };

    lastMessage = await channel.send(options);

    const size = fs.statSync(part).size;

    addedParts.push({
      url: lastMessage.attachments.first().url,
      name: lastMessage.attachments.first().name,
      timestamp: lastMessage.createdTimestamp,
      messageId: lastMessage.id,
      size
    });
  }

  return addedParts;
}

// database local update
async function updateLocalDB() {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    let allMessages = [];
    let lastId;

    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;

      const fetched = await channel.messages.fetch(options);
      if (fetched.size === 0) break;

      const botMessages = fetched.filter(m => m.author.id === client.user.id);
      allMessages = allMessages.concat(Array.from(botMessages.values()));
      lastId = fetched.last().id;
    }

    const db = { files: {}, stats: { totalMessages: allMessages.length, totalFiles: 0 } };

    for (const msg of allMessages) {
      for (const attachment of msg.attachments.values()) {
        const match = attachment.name.match(/(.+?)(\.part\d+)?$/);
        const originalName = match ? match[1] : attachment.name;

        if (!db.files[originalName]) db.files[originalName] = [];
        db.files[originalName].push({
          url: attachment.url,
          name: attachment.name,
          timestamp: msg.createdTimestamp,
          messageId: msg.id,
          size: attachment.size || 0
        });
        db.stats.totalFiles++;
      }
    }

    for (const key in db.files) db.files[key].sort((a,b) => a.timestamp - b.timestamp);

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    console.log('Local DB updated');

  } catch (err) {
    console.error('Error updating local DB:', err);
  }
}

// routes
app.use(express.static('.'));

// upload multiple shi
app.post('/upload', upload.array('files', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).send('No files uploaded');

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);

    let db = { files: {}, stats: { totalMessages: 0, totalFiles: 0 } };
    if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH));

    for (const file of req.files) {
      const originalName = file.originalname;
      const tempPath = path.join('temp', originalName);
      fs.copyFileSync(file.path, tempPath);

      const addedParts = await uploadFileInParts(channel, tempPath);

      if (!db.files[originalName]) db.files[originalName] = [];
      db.files[originalName] = db.files[originalName].concat(addedParts);
      db.stats.totalMessages += 1;
      db.stats.totalFiles += addedParts.length;

      // clean files
      fs.unlinkSync(file.path);
      fs.unlinkSync(tempPath);
      fs.readdirSync('uploads').forEach(f => { 
        if (f.startsWith(file.filename)) fs.unlinkSync(path.join('uploads', f)); 
      });
    }

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    res.send('Files uploaded and local DB updated!');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error uploading files');
  }
});

// sort by size ig
app.get('/files', (req, res) => {
  if (!fs.existsSync(DB_PATH)) return res.json([]);
  const db = JSON.parse(fs.readFileSync(DB_PATH));

  const filesArray = Object.entries(db.files).map(([name, parts]) => {
    const totalSize = parts.reduce((acc, p) => acc + (p.size || 0), 0);
    return { name, parts, totalSize };
  });

  filesArray.sort((a, b) => a.totalSize - b.totalSize);

  res.json(filesArray);
});

// downloading files
app.get('/download', async (req, res) => {
  const fileName = req.query.name;
  if (!fileName) return res.status(400).send('Missing "name" parameter');
  if (!fs.existsSync(DB_PATH)) return res.status(500).send('Local DB does not exist');

  const db = JSON.parse(fs.readFileSync(DB_PATH));
  const parts = db.files[fileName];
  if (!parts || !parts.length) return res.status(404).send('File not found');

  try {
    const buffers = [];
    for (const p of parts) {
      const resp = await fetch(p.url);
      if (!resp.ok) throw new Error(`Failed to download ${p.url}: ${resp.status}`);
      const ab = await resp.arrayBuffer();
      buffers.push(Buffer.from(ab));
    }

    const merged = Buffer.concat(buffers);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(merged);
  } catch (err) {
    console.error('Error in /download:', err);
    res.status(500).send('Error downloading file: ' + err.message);
  }
});

// deleting files
app.delete('/delete', async (req, res) => {
  const fileName = req.query.name;
  if (!fileName) return res.status(400).send('Missing "name" parameter');
  if (!fs.existsSync(DB_PATH)) return res.status(500).send('Local DB does not exist');

  const db = JSON.parse(fs.readFileSync(DB_PATH));
  const parts = db.files[fileName];
  if (!parts || !parts.length) return res.status(404).send('File not found');

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    for (const p of parts) {
      try {
        const msg = await channel.messages.fetch(p.messageId);
        if (msg) await msg.delete();
      } catch (err) {
        console.warn(`Could not delete message ${p.messageId}: ${err.message}`);
      }
    }

    delete db.files[fileName];
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    res.send('File deleted successfully');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting file');
  }
});

// stats
app.get('/stats', (req, res) => {
  if (!fs.existsSync(DB_PATH)) return res.json({ totalMessages: 0, totalFiles: 0 });
  const db = JSON.parse(fs.readFileSync(DB_PATH));
  res.json(db.stats);
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
