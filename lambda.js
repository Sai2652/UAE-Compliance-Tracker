// AWS Lambda entry point. Wraps the Express app via serverless-express so
// API Gateway → Lambda invocations get standard req/res semantics.
//
// Cold start: initDatabase() runs once per container. It hydrates the users +
// tracker-state cache from AWS and seeds the admin row if missing. All
// subsequent invocations reuse the container's warm cache.
//
// This file is only used on Lambda — local dev goes through server.js.
require('dotenv').config();
process.env.IS_LAMBDA = 'true';

const serverlessExpress = require('@vendia/serverless-express');
const { buildApp } = require('./app');
const { initDatabase } = require('./database');

let handlerPromise = null;

async function build() {
  await initDatabase();
  const app = buildApp();
  return serverlessExpress({ app });
}

exports.handler = async function(event, context) {
  context.callbackWaitsForEmptyEventLoop = false;
  if (!handlerPromise) handlerPromise = build();
  const handler = await handlerPromise;
  return handler(event, context);
};
