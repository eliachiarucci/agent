import express from 'express';

export const config = {
    timeout: 1000,
}

export const POST: express.RequestHandler = async (req, res) => {
    res.json({ message: 'Hello, World!' });
}