/*eslint-disable no-console*/
const http = require('http')
const express = require('express')
const cors = require('cors')
const morgan = require('morgan')
const middleware = require('./middleware')
const { fetchStats } = require('./cloudflare')

const fs = require('fs')
const path = require('path')

const sendHomePage = (publicDir) => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')

  return (req, res, next) => {
    fetchStats((error, stats) => {
      if (error) {
        next(error)
      } else {
        res.set('Cache-Control', 'public, max-age=60')
        res.send(
          // Replace the __SERVER_DATA__ token that was added to the
          // HTML file in the build process (see scripts/build.js).
          html.replace('__SERVER_DATA__', JSON.stringify({
            cloudflareStats: stats
          }))
        )
      }
    })
  }
}

const errorHandler = (err, req, res, next) => {
  res.status(500).send('<p>Internal Server Error</p>')
  console.error(err.stack)
  next(err)
}

const raven = require('raven')

if (process.env.SENTRY_DSN)
  raven.config(process.env.SENTRY_DSN, {
    environment: process.env.NODE_ENV || 'development',
    autoBreadcrumbs: true
  }).install()

const createServer = (config) => {
  const app = express()

  if (process.env.SENTRY_DSN) {
    app.use(raven.requestHandler())
    app.use(raven.errorHandler())
  }

  app.disable('x-powered-by')

  if (process.env.NODE_ENV !== 'production')
    app.use(morgan('dev'))

  if (process.env.LOG_IDS)
    app.use(morgan('[:date[clf]] :method :url req-id=:req[x-request-id] cf-ray=:req[cf-ray]'))

  app.use(errorHandler)
  app.use(cors())

  app.get('/', sendHomePage(config.publicDir))

  app.use(express.static(config.publicDir, {
    maxAge: config.maxAge
  }))

  app.use(middleware.createRequestHandler(config))

  const server = http.createServer(app)

  // Heroku dynos automatically timeout after 30s. Set our
  // own timeout here to force sockets to close before that.
  // https://devcenter.heroku.com/articles/request-timeout
  if (config.timeout) {
    server.setTimeout(config.timeout, (socket) => {
      const message = `Timeout of ${config.timeout}ms exceeded`

      socket.end([
        `HTTP/1.1 503 Service Unavailable`,
        `Date: ${(new Date).toGMTString()}`,
        `Content-Type: text/plain`,
        `Content-Length: ${message.length}`,
        `Connection: close`,
        ``,
        message
      ].join(`\r\n`))
    })
  }

  return server
}

const defaultServerConfig = {
  id: 1,
  port: parseInt(process.env.PORT, 10) || 5000,
  publicDir: 'public',
  timeout: parseInt(process.env.TIMEOUT, 10) || 20000,
  maxAge: process.env.MAX_AGE || '365d',

  // for express-unpkg
  registryURL: process.env.REGISTRY_URL || 'https://registry.npmjs.org',
  redirectTTL: process.env.REDIRECT_TTL || 500,
  autoIndex: !process.env.DISABLE_INDEX,
  blacklist: require('./package-blacklist').blacklist
}

const startServer = (serverConfig = {}) => {
  const config = Object.assign({}, defaultServerConfig, serverConfig)
  const server = createServer(config)

  server.listen(config.port, () => {
    console.log('Server #%s listening on port %s, Ctrl+C to stop', config.id, config.port)
  })
}

module.exports = {
  createServer,
  startServer
}
