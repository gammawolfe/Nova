import express from 'express';

const received: any[] = [];
const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
  console.log(`[REPLY RECEIVER] Got result delivery:`, JSON.stringify(req.body, null, 2));
  received.push(req.body);
  res.status(200).json({ received: true });
});

app.get('/results', (_req, res) => {
  res.json(received);
});

const PORT = process.env.REPLY_PORT || 4001;
app.listen(PORT, () => {
  console.log(`[REPLY RECEIVER] Listening on http://localhost:${PORT}`);
});
