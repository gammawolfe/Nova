import crypto from 'crypto';
import { RequestHandler } from 'express';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

export const adminAuth: RequestHandler = (req, res, next) => {
  if (!ADMIN_TOKEN) {
    res.status(500).json({ error: 'ADMIN_TOKEN not configured' });
    return;
  }

  const header = req.headers.authorization;
  const expected = `Bearer ${ADMIN_TOKEN}`;
  if (
    !header ||
    header.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected))
  ) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
};
