import crypto from 'crypto';
import { RequestHandler } from 'express';
import { ADMIN_TOKEN } from '../config';

const expected = `Bearer ${ADMIN_TOKEN}`;
const expectedBuf = Buffer.from(expected);

export const adminAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  if (
    !header ||
    header.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(header), expectedBuf)
  ) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
};
