/* global db */
// Runs once, on the first start of an empty data volume: least-privilege app user scoped to the app DB.
db.getSiblingDB('workout').createUser({
  user: 'workout_app',
  pwd: process.env.MONGO_APP_PASSWORD,
  roles: [{ role: 'readWrite', db: 'workout' }],
});
