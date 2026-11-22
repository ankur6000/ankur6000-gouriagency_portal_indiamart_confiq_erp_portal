import http from 'node:http'
import { createHmac, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GridFSBucket, MongoClient } from 'mongodb'
import { gunzipSync, gzipSync } from 'node:zlib'
import nodemailer from 'nodemailer'
import { createOrderLedgerPdf, createPaymentReceiptPdf } from '../src/orderPdf.js'
import { createStatementPdf } from '../src/statementPdf.js'
import { createIndiaHolidayCalendar } from '../src/indiaHolidayEngine.js'
import { indiaHolidayStates } from '../src/indiaHolidayStates.js'

const PORT = Number(process.env.PORT || 3001)
const DIST_DIRECTORY = resolve(fileURLToPath(new URL('../dist/', import.meta.url)))
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2'
}
const MONGODB_URI = String(process.env.MONGODB_URI || '').trim()
const MONGODB_DB_NAME = String(process.env.MONGODB_DB_NAME || 'gouri_agency').trim() || 'gouri_agency'
if (!MONGODB_URI) throw new Error('MongoDB Atlas is required. Set MONGODB_URI in the ignored .env file before starting the API.')
let mongoClient
let mongoConnectError
let atlasConnected = false
for (let attempt = 0; attempt < 2 && !atlasConnected; attempt += 1) {
  mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 7000, connectTimeoutMS: 5000, maxPoolSize: 10 })
  try {
    await mongoClient.connect()
    atlasConnected = true
  } catch (error) {
    mongoConnectError = error
    await mongoClient.close().catch(() => {})
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500))
  }
}
if (!atlasConnected) throw new Error(`Could not connect to MongoDB Atlas (${mongoConnectError?.name || 'connection error'}). Check MONGODB_URI, the database user, the cluster status, and the Atlas IP access list.`)
const mongoDb = mongoClient.db(MONGODB_DB_NAME)
await mongoDb.command({ ping: 1 })
const portalStateCollection = mongoDb.collection('portal_state')
const publicSiteStatsCollection = mongoDb.collection('public_site_stats')
const portalStateBucket = new GridFSBucket(mongoDb, { bucketName: 'portal_state_snapshots' })
const homeSliderAssetBucket = new GridFSBucket(mongoDb, { bucketName: 'home_slider_assets' })
async function readGridFsBuffer(bucket, fileId) {
  const chunks = []
  for await (const chunk of bucket.openDownloadStream(fileId)) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
function uploadGridFsBuffer(bucket, filename, bytes, metadata = {}, contentType = 'application/octet-stream') {
  return new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream(filename, { metadata, contentType })
    stream.once('error', reject)
    stream.once('finish', () => resolve(stream.id))
    stream.end(bytes)
  })
}
async function deleteGridFsFile(bucket, fileId) {
  if (!fileId) return
  try { await bucket.delete(fileId) }
  catch (error) { if (error.codeName !== 'FileNotFound' && error.code !== 26) throw error }
}
const MAX_REQUEST_BYTES = 30 * 1024 * 1024
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
const MAX_HOME_SLIDER_IMAGE_BYTES = 2 * 1024 * 1024
const RAZORPAY_KEY_ID = String(process.env.RAZORPAY_KEY_ID || '').trim()
const RAZORPAY_KEY_SECRET = String(process.env.RAZORPAY_KEY_SECRET || '').trim()
const RAZORPAY_CONFIGURED = Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
const RAZORPAY_WEBHOOK_SECRET = String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim()
const CASHFREE_CLIENT_ID = String(process.env.CASHFREE_CLIENT_ID || '').trim()
const CASHFREE_CLIENT_SECRET = String(process.env.CASHFREE_CLIENT_SECRET || '').trim()
const CASHFREE_ENVIRONMENT = String(process.env.CASHFREE_ENVIRONMENT || 'production').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production'
const CASHFREE_API_VERSION = String(process.env.CASHFREE_API_VERSION || '2025-01-01').trim()
const CASHFREE_BASE_URL = CASHFREE_ENVIRONMENT === 'sandbox' ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg'
const CASHFREE_CONFIGURED = Boolean(CASHFREE_CLIENT_ID && CASHFREE_CLIENT_SECRET)
const PORTAL_PUBLIC_URL = String(process.env.PORTAL_PUBLIC_URL || '').trim().replace(/\/+$/, '')
const GSTIN_API_KEY = String(process.env.GSTIN_API_KEY || '').trim()
const GST_VERIFICATION_SIGNING_KEY = randomBytes(32)
const GMAIL_SMTP_HOST = String(process.env.GMAIL_SMTP_HOST || 'smtp.gmail.com').trim()
const GMAIL_SMTP_PORT = Number(process.env.GMAIL_SMTP_PORT || 465)
const GMAIL_SMTP_SECURE = String(process.env.GMAIL_SMTP_SECURE || (GMAIL_SMTP_PORT === 465)).toLowerCase() === 'true'
const GMAIL_USER = String(process.env.GMAIL_USER || 'donotreplygouriagencymailbox@gmail.com').trim()
const GMAIL_APP_PASSWORD = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '')
const EMAIL_FROM = String(process.env.EMAIL_FROM || `Gouri Agency <${GMAIL_USER}>`).trim()
const emailAddressPattern = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/
const normalizeEmailAddress = value => String(value || '').trim().toLowerCase()
function normalizeOrderQuantity(value) {
  if (typeof value === 'number') value = Number.isSafeInteger(value) && value >= 1 ? String(value) : ''
  if (typeof value !== 'string') return null
  const quantity = value.trim()
  return quantity.length <= 60 && /^[A-Za-z0-9][A-Za-z0-9 ./-]{0,59}$/.test(quantity) ? quantity : null
}
const DEFAULT_ADMIN_EMAIL = normalizeEmailAddress(process.env.ADMIN_LOGIN_EMAIL || 'admin@gouriagency.com')
const DEFAULT_ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '001')
function createAdminCredentialRecord(email, password) {
  const salt = randomBytes(16)
  return { email: normalizeEmailAddress(email), salt: salt.toString('hex'), passwordHash: scryptSync(String(password), salt, 64).toString('hex') }
}
function normalizeAdminCredentialRecord(credentials) {
  if (emailAddressPattern.test(normalizeEmailAddress(credentials?.email)) && /^[a-f0-9]{32}$/i.test(credentials?.salt || '') && /^[a-f0-9]{128}$/i.test(credentials?.passwordHash || '')) {
    return { email: normalizeEmailAddress(credentials.email), salt: credentials.salt.toLowerCase(), passwordHash: credentials.passwordHash.toLowerCase() }
  }
  return createAdminCredentialRecord(DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)
}
function verifyAdminPassword(password, credentials) {
  if (typeof password !== 'string' || password.length > 128) return false
  try {
    const actual = scryptSync(password, Buffer.from(credentials.salt, 'hex'), 64)
    const expected = Buffer.from(credentials.passwordHash, 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch { return false }
}
const configuredFromMatch = /<([^<>]+)>/.exec(EMAIL_FROM)
const configuredFromAddress = normalizeEmailAddress(configuredFromMatch?.[1] || EMAIL_FROM)
const EMAIL_ALLOWED_FROM_ADDRESSES = new Set([
  normalizeEmailAddress(GMAIL_USER), configuredFromAddress,
  ...String(process.env.GMAIL_ALLOWED_FROM_ADDRESSES || '').split(/[\s,;]+/).map(normalizeEmailAddress)
].filter(address => emailAddressPattern.test(address)))
const defaultEmailCc = ['upadhyayjagneswar@gmail.com', 'dbachchu@gmail.com']
const defaultEmailFromName = configuredFromMatch ? EMAIL_FROM.slice(0, configuredFromMatch.index).replace(/^['"]|['"]$/g, '').trim() || 'Gouri Agency' : 'Gouri Agency'
function normalizeEmailSettings(settings) {
  const requestedFrom = normalizeEmailAddress(settings?.fromAddress)
  const fromAddress = EMAIL_ALLOWED_FROM_ADDRESSES.has(requestedFrom) ? requestedFrom : (configuredFromAddress || normalizeEmailAddress(GMAIL_USER))
  const rawCc = Array.isArray(settings?.ccEmails) ? settings.ccEmails : defaultEmailCc
  const ccEmails = [...new Set(rawCc.map(normalizeEmailAddress).filter(address => emailAddressPattern.test(address)))].slice(0, 20)
  const fromName = typeof settings?.fromName === 'string' ? settings.fromName.replace(/[<>\r\n\x00-\x1f]/g, '').trim().slice(0, 80) : ''
  return { fromName: fromName || defaultEmailFromName, fromAddress, ccEmails }
}
const EMAIL_CONFIGURED = Boolean(GMAIL_SMTP_HOST && GMAIL_SMTP_PORT > 0 && GMAIL_USER && GMAIL_APP_PASSWORD && EMAIL_FROM)
const mailTransport = EMAIL_CONFIGURED ? nodemailer.createTransport({
  host: GMAIL_SMTP_HOST,
  port: GMAIL_SMTP_PORT,
  secure: GMAIL_SMTP_SECURE,
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  connectionTimeout: 8000,
  greetingTimeout: 8000,
  socketTimeout: 15000
}) : null
const DAY_MS = 24 * 60 * 60 * 1000
const blankBankTransferDetails = { accountName: '', bankName: '', accountNumber: '', ifscCode: '', branch: '', instructions: '' }
const normalizePromoDate = value => {
  if (typeof value !== 'string' || !value.trim()) return ''
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : ''
}
function isPromoCodeLive(promo, now = Date.now()) {
  if (!promo?.enabled || !promo.code || Number(promo.discountValue) <= 0) return false
  const startsAt = promo.startsAt ? Date.parse(promo.startsAt) : null
  const endsAt = promo.endsAt ? Date.parse(promo.endsAt) : null
  return (startsAt === null || (Number.isFinite(startsAt) && now >= startsAt)) && (endsAt === null || (Number.isFinite(endsAt) && now < endsAt))
}
const defaultHomeSliderNames = ['Healthcare supplies', 'Distribution center', 'Reliable delivery', 'Community pharmacy', 'Careful handling', 'Secure supply chain']
function normalizeHomeSlider(settings) {
  const intervalSeconds = Number(settings?.intervalSeconds)
  const images = Array.isArray(settings?.images)
    ? settings.images
    : Array.from({ length: 6 }, (_, index) => ({ id: `default-slide-${index + 1}`, name: defaultHomeSliderNames[index], type: 'image/svg+xml' }))
  return {
    enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : true,
    intervalSeconds: Number.isInteger(intervalSeconds) && intervalSeconds >= 3 && intervalSeconds <= 120 ? intervalSeconds : 10,
    images: Array.from({ length: 6 }, (_, index) => {
      const image = images[index]
      const defaultId = `default-slide-${index + 1}`
      if (image?.id === defaultId && image.type === 'image/svg+xml') return { id: defaultId, name: defaultHomeSliderNames[index], type: 'image/svg+xml' }
      if (!image || !/^[a-f0-9-]{36}$/.test(image.id || '') || !['image/jpeg', 'image/png'].includes(image.type)) return null
      const name = typeof image.name === 'string' ? image.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) : `Home slide ${index + 1}`
      return { id: image.id, name: name || `Home slide ${index + 1}`, type: image.type }
    })
  }
}
function normalizeHomeNotices(items) {
  if (!Array.isArray(items)) return []
  return items.slice(0, 200).map(item => {
    const title = typeof item?.title === 'string' ? item.title.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : ''
    const body = typeof item?.body === 'string' ? item.body.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, 15000) : ''
    const createdTimestamp = Date.parse(item?.createdAt || '')
    if (!title || !body || typeof item?.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(item.id)) return null
    return {
      id: item.id.toLowerCase(),
      title,
      body,
      priority: item.priority === 'high' ? 'high' : 'standard',
      createdAt: Number.isFinite(createdTimestamp) ? new Date(createdTimestamp).toISOString() : new Date().toISOString()
    }
  }).filter(Boolean).sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt))
}
const homeSliderDirectory = new URL('./home-slider-assets/', import.meta.url)
function normalizePaymentSettings(settings) {
  const bank = settings?.bankTransfer || {}
  const reminders = settings?.dueReminders || {}
  const orderIntake = settings?.orderIntake || {}
  const promo = settings?.promoCode || {}
  const intervalDays = Number(reminders.intervalDays)
  const promoDiscountValue = Number(promo.discountValue)
  const closedMessage = typeof orderIntake.message === 'string' ? orderIntake.message.trim().slice(0, 300) : ''
  return {
    bankTransfer: Object.fromEntries(Object.keys(blankBankTransferDetails).map(key => [key, typeof bank[key] === 'string' ? bank[key] : ''])),
    dueReminders: {
      enabled: typeof reminders.enabled === 'boolean' ? reminders.enabled : true,
      intervalDays: Number.isInteger(intervalDays) && intervalDays >= 1 && intervalDays <= 365 ? intervalDays : 7
    },
    orderIntake: {
      enabled: typeof orderIntake.enabled === 'boolean' ? orderIntake.enabled : true,
      message: closedMessage || 'Order requests are temporarily closed. Please contact Gouri Agency for assistance.'
    },
    promoCode: {
      enabled: typeof promo.enabled === 'boolean' ? promo.enabled : false,
      code: typeof promo.code === 'string' ? promo.code.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24) : '',
      discountType: promo.discountType === 'fixed' ? 'fixed' : 'percent',
      discountValue: Number.isFinite(promoDiscountValue) && promoDiscountValue >= 0 ? Math.min(promoDiscountValue, 1000000000) : 0,
      emoji: typeof promo.emoji === 'string' ? promo.emoji.slice(0, 12) : '🎉',
      startsAt: normalizePromoDate(promo.startsAt),
      endsAt: normalizePromoDate(promo.endsAt)
    }
  }
}
const portalStateFile = new URL('./.portal-state.json', import.meta.url)
const orderIdSequenceFile = new URL('./.order-id-sequence', import.meta.url)
function createEmailSerialSeed() {
  return randomInt(1000, 10000) * 100000000000 + (Date.now() % 100000000000)
}
function loadLegacyNextOrderId() {
  try {
    const value = Number(readFileSync(orderIdSequenceFile, 'utf8').trim())
    return Number.isInteger(value) && value >= 1 && value <= 1000000 ? value : 1
  } catch (error) {
    if (error.code === 'ENOENT') return 1
    throw new Error(`Could not load the legacy order sequence: ${error.message}`)
  }
}
function normalizePortalState(state = {}) {
  return {
    orders: Array.isArray(state.orders) ? state.orders : [],
    profiles: Array.isArray(state.profiles) ? state.profiles : [],
    trash: Array.isArray(state.trash) ? state.trash : [],
    emailOutbox: Array.isArray(state.emailOutbox) ? state.emailOutbox : [],
    communicationMessages: Array.isArray(state.communicationMessages) ? state.communicationMessages : [],
    processedRazorpayEvents: Array.isArray(state.processedRazorpayEvents) ? state.processedRazorpayEvents : [],
    processedCashfreeEvents: Array.isArray(state.processedCashfreeEvents) ? state.processedCashfreeEvents : [],
    paymentSettings: normalizePaymentSettings(state.paymentSettings),
    emailSettings: normalizeEmailSettings(state.emailSettings),
    adminCredentials: normalizeAdminCredentialRecord(state.adminCredentials),
    homeSlider: normalizeHomeSlider(state.homeSlider),
    notices: normalizeHomeNotices(state.notices),
    nextEmailSerial: Number.isSafeInteger(state.nextEmailSerial) && state.nextEmailSerial >= 100000000000000 && state.nextEmailSerial <= 999999999999999 ? state.nextEmailSerial : null,
    nextProfileId: Number.isInteger(state.nextProfileId) && state.nextProfileId >= 1001 ? state.nextProfileId : 1001,
    nextOrderId: Number.isInteger(state.nextOrderId) && state.nextOrderId >= 1 && state.nextOrderId <= 1000000 ? state.nextOrderId : loadLegacyNextOrderId()
  }
}
let currentPortalSnapshotId = null
async function loadPortalState() {
  const stored = await portalStateCollection.findOne({ _id: 'current' })
  if (stored?.snapshotId) {
    currentPortalSnapshotId = stored.snapshotId
    const compressed = await readGridFsBuffer(portalStateBucket, stored.snapshotId)
    return { state: normalizePortalState(JSON.parse(gunzipSync(compressed).toString('utf8'))), source: 'atlas' }
  }
  try {
    const state = JSON.parse(readFileSync(portalStateFile, 'utf8'))
    return { state: normalizePortalState(state), source: 'legacy-file' }
  } catch (error) {
    if (error.code === 'ENOENT') return { state: normalizePortalState(), source: 'empty' }
    throw new Error(`Could not load saved portal data: ${error.message}`)
  }
}
const loadedPortalState = await loadPortalState()
const savedState = loadedPortalState.state
const hasLegacyStateToImport = loadedPortalState.source === 'legacy-file'
const orders = savedState.orders
const profilesByGst = new Map(savedState.profiles.map(profile => [String(profile.gstNumber || '').trim().toUpperCase().replace(/\s+/g, ''), profile]))
const trash = savedState.trash
const emailOutbox = savedState.emailOutbox
const communicationMessages = savedState.communicationMessages
const notices = savedState.notices
const processedRazorpayEvents = new Set(savedState.processedRazorpayEvents)
const processedCashfreeEvents = new Set(savedState.processedCashfreeEvents)
let paymentSettings = normalizePaymentSettings(savedState.paymentSettings)
let emailSettings = normalizeEmailSettings(savedState.emailSettings)
let adminCredentials = normalizeAdminCredentialRecord(savedState.adminCredentials)
const adminCredentialsMigrated = adminCredentials.email === normalizeEmailAddress('admin@gouri.agency') && verifyAdminPassword('gouri123', adminCredentials)
if (adminCredentialsMigrated) adminCredentials = createAdminCredentialRecord(DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)
let homeSlider = normalizeHomeSlider(savedState.homeSlider)
const latestExistingSerial = emailOutbox.reduce((latest, job) => Math.max(latest, /^\d{15}$/.test(job.serial || '') ? Number(job.serial) : 0), 0)
let nextEmailSerial = Math.max(savedState.nextEmailSerial || createEmailSerialSeed(), latestExistingSerial + 1)
function reserveEmailSerial() {
  if (!Number.isSafeInteger(nextEmailSerial) || nextEmailSerial > 999999999999999) throw new Error('The 15-digit email serial range has been exhausted.')
  return String(nextEmailSerial++)
}
if (EMAIL_CONFIGURED) for (const job of emailOutbox) if (job.status === 'needs_configuration') job.status = 'pending'
const adminSessions = new Set()
const clientSessions = new Map()
let nextId = savedState.nextOrderId
let nextProfileId = savedState.nextProfileId
let persistenceTail = Promise.resolve()
let pendingPortalPersistenceWrites = 0
let portalRefreshLastCheckedAt = Date.now()
let portalRefreshInFlight = null
let portalRefreshFailureCount = 0
let portalRefreshRetryAfter = 0
let portalRefreshLastError = null
const PORTAL_REFRESH_INTERVAL_MS = 1500
function installPortalState(state) {
  const normalized = normalizePortalState(state)
  orders.splice(0, orders.length, ...normalized.orders)
  profilesByGst.clear()
  for (const profile of normalized.profiles) profilesByGst.set(String(profile.gstNumber || '').trim().toUpperCase().replace(/\s+/g, ''), profile)
  trash.splice(0, trash.length, ...normalized.trash)
  emailOutbox.splice(0, emailOutbox.length, ...normalized.emailOutbox)
  communicationMessages.splice(0, communicationMessages.length, ...normalized.communicationMessages)
  processedRazorpayEvents.clear()
  for (const eventId of normalized.processedRazorpayEvents) processedRazorpayEvents.add(eventId)
  processedCashfreeEvents.clear()
  for (const eventId of normalized.processedCashfreeEvents) processedCashfreeEvents.add(eventId)
  paymentSettings = normalized.paymentSettings
  emailSettings = normalized.emailSettings
  adminCredentials = normalized.adminCredentials
  homeSlider = normalized.homeSlider
  notices.splice(0, notices.length, ...normalized.notices)
  const latestSerial = emailOutbox.reduce((latest, job) => Math.max(latest, /^\d{15}$/.test(job.serial || '') ? Number(job.serial) : 0), 0)
  nextEmailSerial = Math.max(normalized.nextEmailSerial || createEmailSerialSeed(), latestSerial + 1)
  nextProfileId = normalized.nextProfileId
  nextId = normalized.nextOrderId
}
async function refreshPortalStateFromAtlas({ force = false, required = false } = {}) {
  const now = Date.now()
  if (portalRefreshInFlight) return portalRefreshInFlight
  if (pendingPortalPersistenceWrites > 0 || (!force && now - portalRefreshLastCheckedAt < PORTAL_REFRESH_INTERVAL_MS)) return
  if (now < portalRefreshRetryAfter) {
    if (required) throw portalRefreshLastError || new Error('MongoDB Atlas is temporarily unavailable.')
    return
  }
  const task = (async () => {
    const latest = await portalStateCollection.findOne({ _id: 'current' }, { projection: { snapshotId: 1 }, maxTimeMS: 5000 })
    if (!latest?.snapshotId) throw new Error('MongoDB Atlas has no portal state snapshot.')
    if (String(latest.snapshotId) === String(currentPortalSnapshotId)) return
    const compressed = await readGridFsBuffer(portalStateBucket, latest.snapshotId)
    installPortalState(JSON.parse(gunzipSync(compressed).toString('utf8')))
    currentPortalSnapshotId = latest.snapshotId
  })()
  portalRefreshInFlight = task
  try {
    await task
    portalRefreshFailureCount = 0
    portalRefreshRetryAfter = 0
    portalRefreshLastError = null
  } catch (error) {
    portalRefreshFailureCount = Math.min(portalRefreshFailureCount + 1, 5)
    portalRefreshRetryAfter = Date.now() + Math.min(15_000, 2_000 * (2 ** (portalRefreshFailureCount - 1)))
    portalRefreshLastError = error
    throw error
  }
  finally {
    portalRefreshLastCheckedAt = Date.now()
    if (portalRefreshInFlight === task) portalRefreshInFlight = null
  }
}
function persistPortalState() {
  const snapshot = gzipSync(Buffer.from(JSON.stringify({ version: 1, orders, profiles: [...profilesByGst.values()], trash, emailOutbox, communicationMessages, processedRazorpayEvents: [...processedRazorpayEvents], processedCashfreeEvents: [...processedCashfreeEvents], paymentSettings, emailSettings, adminCredentials, homeSlider, notices, nextEmailSerial, nextProfileId, nextOrderId: nextId })))
  pendingPortalPersistenceWrites += 1
  const task = persistenceTail.catch(() => {}).then(async () => {
    const previousSnapshotId = currentPortalSnapshotId
    const nextSnapshotId = await uploadGridFsBuffer(portalStateBucket, `portal-state-${Date.now()}.json.gz`, snapshot, { kind: 'portal-state', format: 'gzip-json-v1' }, 'application/gzip')
    await portalStateCollection.updateOne({ _id: 'current' }, { $set: { snapshotId: nextSnapshotId, format: 'gzip-json-v1', revision: String(nextSnapshotId), updatedAt: new Date() } }, { upsert: true })
    currentPortalSnapshotId = nextSnapshotId
    if (previousSnapshotId && String(previousSnapshotId) !== String(nextSnapshotId)) {
      await deleteGridFsFile(portalStateBucket, previousSnapshotId).catch(error => console.error('Could not remove the previous MongoDB state snapshot:', error.message))
    }
  })
  persistenceTail = task
  task.then(
    () => { pendingPortalPersistenceWrites = Math.max(0, pendingPortalPersistenceWrites - 1) },
    () => { pendingPortalPersistenceWrites = Math.max(0, pendingPortalPersistenceWrites - 1) }
  )
  task.catch(error => console.error('Could not persist portal state to MongoDB Atlas:', error.message))
  return task
}
const trashMetadata = item => {
  const deletedProfile = item.type === 'profile' ? (item.payload?.profile || item.payload) : null
  const deletedOrder = item.type === 'order' ? item.payload : null
  const orderIds = item.type === 'profile'
    ? (item.payload?.orders?.map(order => order.id) || deletedProfile?.orderIds || [])
    : (item.orderId ? [item.orderId] : [])
  return {
    id: item.id,
    type: item.type,
    label: item.label,
    profileId: item.profileId,
    orderId: item.orderId || null,
    orderIds,
    email: deletedProfile?.email || deletedOrder?.email || '',
    mobile: deletedProfile?.mobile || deletedOrder?.mobile || '',
    gstNumber: deletedProfile?.gstNumber || deletedOrder?.gstNumber || '',
    orderCount: item.orderCount || 0,
    deletedBy: item.deletedBy,
    reason: item.reason || 'deleted',
    deletedAt: item.deletedAt,
    expiresAt: item.expiresAt
  }
}
function addToTrash({ type, label, profileId, orderId, orderCount = 0, deletedBy, reason, payload }) {
  const deletedAt = new Date().toISOString()
  const item = {
    id: `TRASH-${randomUUID().toUpperCase()}`,
    type, label, profileId, orderId: orderId || null, orderCount, deletedBy, reason,
    deletedAt,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    payload: JSON.parse(JSON.stringify(payload))
  }
  trash.unshift(item)
  return item
}
function deleteActiveProfile(profile) {
  profilesByGst.delete(normalizeGst(profile.gstNumber))
  const relatedOrders = orders.filter(order => order.profileId === profile.id)
  for (let index = orders.length - 1; index >= 0; index--) {
    if (orders[index].profileId === profile.id) orders.splice(index, 1)
  }
  for (const [token, profileId] of clientSessions) if (profileId === profile.id) clientSessions.delete(token)
  return relatedOrders
}
function purgeExpiredTrash() {
  const now = Date.now()
  const expiredProfiles = new Set(trash.filter(item => item.type === 'profile' && Date.parse(item.expiresAt) <= now).map(item => item.profileId))
  const kept = trash.filter(item => Date.parse(item.expiresAt) > now && !(item.type === 'order' && expiredProfiles.has(item.profileId)))
  if (kept.length === trash.length) return false
  trash.splice(0, trash.length, ...kept)
  persistPortalState()
  return true
}
const statusTransitions = {
  'Pending approval': ['Approved', 'Rejected'],
  Approved: ['In progress', 'Rejected'],
  'In progress': ['Approved', 'Rejected', 'Complete'],
  Cancelled: [],
  Rejected: [],
  Complete: []
}
const normalizeGst = value => String(value || '').trim().toUpperCase().replace(/\s+/g, '')
const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const pincodeLookupCache = new Map()
const ifscLookupCache = new Map()
const publicHolidayCache = new Map()
const publicHolidayRequests = new Map()
const holidayTypeLabels = { bank: 'RBI bank holiday', central_gazetted: 'Central government gazetted holiday' }
function holidayEmoji(name) {
  const text = String(name || '')
  if (/republic|independence|gandhi|national|statehood|formation/i.test(text)) return '🇮🇳'
  if (/eid|muharram|shab|ramzan|milad|bakrid|nauroz/i.test(text)) return '🌙'
  if (/christmas|good friday|easter/i.test(text)) return '🎄'
  if (/holi|doljatra/i.test(text)) return '🎨'
  if (/puja|durga|diwali|deepavali|lakshmi|dussehra/i.test(text)) return '🪔'
  if (/buddha|mahabir|mahavir|parshwanath/i.test(text)) return '🪷'
  if (/jayanti|birthday/i.test(text)) return '🌼'
  if (/labour|workers|may day/i.test(text)) return '🛠️'
  return '🎉'
}
function holidayJson(res, status, data, cacheControl = 'public, max-age=900, stale-if-error=86400') {
  if (res.destroyed || res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(data))
}
function isValidHolidayDate(value, year) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) || Number(value.slice(0, 4)) !== year) return false
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}
async function fetchPublishedHolidayList(year, state) {
  const stateAliases = { CT: ['CG'], CG: ['CT'], OR: ['OD'], OD: ['OR'], TG: ['TS'], TS: ['TG'], UT: ['UK'], UK: ['UT'], DN: ['DD'], DD: ['DN'] }
  const stateCodes = new Set([...(state.code ? [state.code] : (state.codes || [])), ...((state.code ? [state.code] : (state.codes || [])).flatMap(code => stateAliases[code] || []))])
  const jobs = Object.keys(holidayTypeLabels).map(async type => {
    const query = new URLSearchParams({ type, state: state.name })
    const response = await fetch(`https://api.dharun.dev/v1/holidays/${year}?${query}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000)
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || !Array.isArray(body?.data)) throw new Error(body?.error?.message || `${type} holiday list unavailable`)
    const source = body.meta?.source
    return {
      holidays: body.data.filter(row => {
        if (!isValidHolidayDate(row?.date, year) || !String(row?.name || '').trim()) return false
        if (!Array.isArray(row.states) || !row.states.length || row.states.includes('*')) return true
        return row.states.some(value => stateCodes.has(String(value).toUpperCase()) || String(value).toLowerCase() === state.name.toLowerCase())
      }).map(row => ({
        date: row.date,
        name: String(row.name).trim(),
        emoji: holidayEmoji(row.name),
        category: holidayTypeLabels[type],
        ...(row.region ? { note: String(row.region).trim() } : {})
      })),
      ...(source?.name && source?.url ? { source: { label: source.name, url: source.url, ...(source.attribution ? { attribution: source.attribution } : {}) } } : {}),
      note: String(body.meta?.note || '').trim()
    }
  })
  const settled = await Promise.allSettled(jobs)
  const responses = settled.filter(item => item.status === 'fulfilled').map(item => item.value)
  const holidays = new Map()
  for (const response of responses) for (const item of response.holidays) holidays.set(`${item.date}-${item.name}-${item.category}`, item)
  const sources = [...new Map(responses.flatMap(item => item.source ? [[item.source.url, item.source]] : []).map(([key, value]) => [key, value])).values()]
  const notes = [...new Set(responses.map(item => item.note).filter(Boolean))]
  if (!holidays.size) throw new Error(settled.map(item => item.status === 'rejected' ? item.reason?.message : '').filter(Boolean).join('; ') || 'No published holiday dates are available yet.')
  return {
    year,
    region: `${state.name}, India`,
    notification: `Published ${year} government and RBI holiday data`,
    sources,
    holidays: [...holidays.values()].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)),
    coverageNote: `${notes.join(' ')} Dates are loaded from published central government and RBI data. State-specific office notices may add local holidays; confirm with the relevant state notice.`,
    retrievedAt: new Date().toISOString()
  }
}
async function getPublicHolidayCalendar(year, state) {
  const key = `${year}:${state.code || (state.codes || []).join('-')}`
  const cached = publicHolidayCache.get(key)
  if (cached?.expiresAt > Date.now()) return cached.calendar
  if (publicHolidayRequests.has(key)) return publicHolidayRequests.get(key)
  const request = fetchPublishedHolidayList(year, state).then(calendar => {
    publicHolidayCache.set(key, { calendar, expiresAt: Date.now() + 6 * 60 * 60_000 })
    return calendar
  }).catch(error => {
    if (cached?.calendar) return { ...cached.calendar, stale: true, coverageNote: `${cached.calendar.coverageNote} Showing the last successfully retrieved copy because the holiday source is temporarily unavailable.` }
    throw error
  }).finally(() => publicHolidayRequests.delete(key))
  publicHolidayRequests.set(key, request)
  return request
}
function issueGstVerificationProof(gstin, registeredName, address, location = {}, issuedAt = Date.now()) {
  const claims = Buffer.from(JSON.stringify({ gstin, registeredName, address, ...location, issuedAt })).toString('base64url')
  const signature = createHmac('sha256', GST_VERIFICATION_SIGNING_KEY).update(claims).digest('hex')
  return `${claims}.${signature}`
}
function readGstVerificationProof(proof) {
  if (typeof proof !== 'string') return null
  const [claims, signature] = proof.split('.')
  if (!claims || !/^[a-f0-9]{64}$/i.test(signature || '')) return null
  const supplied = Buffer.from(signature, 'hex')
  const expected = createHmac('sha256', GST_VERIFICATION_SIGNING_KEY).update(claims).digest()
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null
  try {
    const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'))
    if (!GSTIN_FORMAT.test(parsed.gstin) || !parsed.registeredName || !parsed.address || !Number.isFinite(parsed.issuedAt)) return null
    if (parsed.issuedAt > Date.now() + 30_000 || Date.now() - parsed.issuedAt > 4 * 60 * 60 * 1000) return null
    return parsed
  } catch { return null }
}
const normalizePhone = value => String(value || '').replace(/\D/g, '')
function createOrderId() {
  while (nextId <= 999999) {
    const id = `GA${String(nextId).padStart(6, '0')}`
    const nextSequence = nextId + 1
    if (orders.some(order => order.id === id)) {
      nextId = nextSequence
      continue
    }
    nextId = nextSequence
    return id
  }
  throw new Error('No unused order IDs remain.')
}
function reservedPaymentTotal(order) {
  const now = Date.now()
  return (order.payments || []).filter(payment => payment.status === 'Pending verification' || ['Razorpay payment processing', 'Cashfree payment processing'].includes(payment.status) || (['Awaiting Razorpay payment', 'Awaiting Cashfree payment'].includes(payment.status) && Date.parse(payment.expiresAt) > now)).reduce((sum, payment) => sum + payment.amount, 0)
}
function paymentRefundedForOrder(payment, orderId) {
  if (payment?.provider === 'Account credit') return Number(payment.amountRefunded || 0)
  const processed = (payment?.refunds || []).filter(refund => refund.status === 'processed')
  if (!processed.some(refund => refund.allocationOrderId)) return Number(payment?.amountRefunded || 0)
  return processed.reduce((sum, refund) => sum + (!refund.allocationOrderId || refund.allocationOrderId === orderId ? Number(refund.amount || 0) : 0), 0)
}
function confirmedOrderPaymentAmount(payment, orderId) {
  return Math.max(0, Number(payment?.amountApplied ?? payment?.amount ?? 0) - paymentRefundedForOrder(payment, orderId))
}
function profileAvailableBalance(profileId) {
  return orders.filter(order => order.profileId === profileId && !['Cancelled', 'Rejected'].includes(order.status))
    .reduce((sum, order) => sum + Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0) - reservedPaymentTotal(order)), 0)
}
function carryForwardOrderCandidates(sourceOrder) {
  const sourceDate = Date.parse(sourceOrder.createdAt || sourceOrder.date || '') || 0
  return orders.filter(order => order.profileId === sourceOrder.profileId && order.id !== sourceOrder.id && !['Cancelled', 'Rejected'].includes(order.status))
    .filter(order => Number(order.amountDue || 0) - Number(order.amountPaid || 0) - reservedPaymentTotal(order) > 0.005)
    .sort((a, b) => {
      const aDate = Date.parse(a.createdAt || a.date || '') || 0
      const bDate = Date.parse(b.createdAt || b.date || '') || 0
      const aSubsequent = aDate >= sourceDate
      const bSubsequent = bDate >= sourceDate
      if (aSubsequent !== bSubsequent) return aSubsequent ? -1 : 1
      return aDate - bDate || String(a.id).localeCompare(String(b.id))
    })
}
function addAccountCredit(sourceOrder, sourcePayment, destination, amount) {
  const applied = Math.round(Number(amount) * 100) / 100
  const credit = {
    id: `CREDIT-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`,
    amount: applied,
    amountApplied: applied,
    transactionAmount: Number(sourcePayment.amount || 0),
    provider: 'Account credit',
    originalProvider: sourcePayment.provider || 'Payment',
    status: 'Paid',
    reference: `Credit from ${sourceOrder.id} · ${sourcePayment.reference || sourcePayment.id}`,
    sourceOrderId: sourceOrder.id,
    sourcePaymentId: sourcePayment.id,
    allocatedAt: sourcePayment.paidAt || sourcePayment.reviewedAt || new Date().toISOString(),
    paidAt: sourcePayment.paidAt || sourcePayment.reviewedAt || new Date().toISOString(),
    allocationKind: 'carry-forward'
  }
  destination.payments ||= []
  destination.payments.unshift(credit)
  recomputeOrderPaidAmount(destination)
  sourcePayment.allocations ||= []
  sourcePayment.allocations.push({ orderId: destination.id, shopName: destination.shopName || '', amount: applied, role: 'carry-forward', paymentId: credit.id })
  return credit
}
function refreshPaymentAllocationSummary(payment) {
  payment.amountCarriedForward = Math.round((payment.allocations || []).filter(row => row.role === 'carry-forward').reduce((sum, row) => sum + Number(row.amount || 0), 0) * 100) / 100
  payment.totalAllocated = Math.round((payment.allocations || []).reduce((sum, row) => sum + Number(row.amount || 0), 0) * 100) / 100
}
function applyConfirmedPaymentAllocation(order, payment) {
  if (payment.allocationFinalizedAt || !['Paid', 'Verified'].includes(payment.status)) return
  const transactionAmount = Math.max(0, Number(payment.amount || 0))
  const sourceOutstanding = order.status === 'Cancelled'
    ? transactionAmount
    : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0) - reservedPaymentTotal(order))
  const sourceAmount = Math.round(Math.min(transactionAmount, sourceOutstanding) * 100) / 100
  payment.amountApplied = sourceAmount
  payment.allocations = sourceAmount > 0 ? [{ orderId: order.id, shopName: order.shopName || '', amount: sourceAmount, role: 'order' }] : []
  let remaining = Math.round((transactionAmount - sourceAmount) * 100) / 100
  recomputeOrderPaidAmount(order)
  if (order.status !== 'Cancelled' && remaining > 0.005) {
    for (const destination of carryForwardOrderCandidates(order)) {
      const available = Math.max(0, Number(destination.amountDue || 0) - Number(destination.amountPaid || 0) - reservedPaymentTotal(destination))
      const applied = Math.round(Math.min(remaining, available) * 100) / 100
      if (applied <= 0) continue
      addAccountCredit(order, payment, destination, applied)
      remaining = Math.round((remaining - applied) * 100) / 100
      if (remaining <= 0.005) break
    }
  }
  refreshPaymentAllocationSummary(payment)
  payment.unallocatedAmount = Math.max(0, Math.round(remaining * 100) / 100)
  payment.allocationFinalizedAt = new Date().toISOString()
  recomputeOrderPaidAmount(order)
}
function getOrderPaymentEditLockUntil(order) {
  if (order?.status === 'Cancelled') return ''
  if (order?.paymentEditLockedUntil) return order.paymentEditLockedUntil
  if (Number(order?.amountDue || 0) <= 0 || Number(order?.amountPaid || 0) < Number(order?.amountDue || 0)) return ''
  const paidAt = (order.payments || [])
    .filter(payment => ['Paid', 'Verified'].includes(payment.status))
    .map(payment => Date.parse(payment.paidAt || payment.reviewedAt || payment.submittedAt))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0]
  return paidAt ? new Date(paidAt + DAY_MS).toISOString() : ''
}
function getLastConfirmedPaymentAt(order) {
  if (order?.lastPaymentAt) return order.lastPaymentAt
  return (order?.payments || [])
    .filter(payment => ['Paid', 'Verified'].includes(payment.status))
    .map(payment => payment.paidAt || payment.reviewedAt || payment.submittedAt)
    .filter(value => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || ''
}
function orderForDashboard(order) {
  const { paidBalanceAdjustment, ...visibleOrder } = order
  return { ...visibleOrder, attachments: dashboardAttachmentMetadata(visibleOrder.attachments), lastPaymentAt: getLastConfirmedPaymentAt(order), paymentEditLockedUntil: getOrderPaymentEditLockUntil(order) }
}
function clientOrderForDashboard(order) {
  const { costAmount, paidBalanceAdjustment, ...visibleOrder } = order
  return { ...visibleOrder, attachments: dashboardAttachmentMetadata(visibleOrder.attachments), lastPaymentAt: getLastConfirmedPaymentAt(order), paymentEditLockedUntil: getOrderPaymentEditLockUntil(order) }
}
function isOrderPaymentEditLocked(order) {
  const lockUntil = Date.parse(getOrderPaymentEditLockUntil(order))
  return Number.isFinite(lockUntil) && lockUntil > Date.now()
}
function hasUnresolvedOnlineRefund(order) {
  return (order?.payments || []).some(payment => ['pending', 'failed', 'partially_refunded'].includes(payment.refundStatus))
}
async function razorpayRequest(path, { method = 'GET', body } = {}) {
  const authorization = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64')
  const response = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method,
    headers: { Authorization: `Basic ${authorization}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error?.description || 'Razorpay could not process the request.')
  return data
}
async function cashfreeRequest(path, { method = 'GET', body } = {}) {
  if (!CASHFREE_CONFIGURED) throw new Error('Cashfree is not configured on the server.')
  const response = await fetch(`${CASHFREE_BASE_URL}/${path}`, {
    method,
    headers: {
      'x-api-version': CASHFREE_API_VERSION,
      'x-client-id': CASHFREE_CLIENT_ID,
      'x-client-secret': CASHFREE_CLIENT_SECRET,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.message || data.error?.description || data.code || 'Cashfree could not process the request.')
    error.status = response.status
    throw error
  }
  return data
}
function cashfreeRefundStatus(status) {
  const normalized = String(status || '').toUpperCase()
  if (normalized === 'SUCCESS') return 'processed'
  if (['FAILED', 'CANCELLED', 'REJECTED'].includes(normalized)) return 'failed'
  return 'pending'
}
function updateCashfreeRefundRecord(payment, providerRefund, existing = {}) {
  const refund = existing
  const status = cashfreeRefundStatus(providerRefund.refund_status)
  Object.assign(refund, {
    id: String(providerRefund.refund_id || refund.id || providerRefund.cf_refund_id || ''),
    providerRefundId: String(providerRefund.cf_refund_id || refund.providerRefundId || ''),
    amount: Number(providerRefund.refund_amount ?? refund.amount ?? 0),
    currency: providerRefund.refund_currency || 'INR',
    status,
    reason: refund.reason || providerRefund.refund_note || 'Client order cancellation',
    arn: providerRefund.refund_arn || refund.arn || '',
    updatedAt: new Date().toISOString()
  })
  payment.refunds ||= []
  if (!payment.refunds.includes(refund)) payment.refunds.push(refund)
  return refund
}
async function initiateCashfreeRefund(order, payment, { amount = null, reason = 'Client order cancellation', allocationOrderId = '' } = {}) {
  if (payment.provider !== 'Cashfree' || !payment.cashfreeOrderId || !payment.cashfreePaymentId) throw new Error('Only a confirmed Cashfree payment can be refunded automatically.')
  const lockKey = `${order.id}/${payment.id}`
  if (razorpayRefundsInProgress.has(lockKey)) return { status: payment.refundStatus || 'pending', duplicate: true }
  razorpayRefundsInProgress.add(lockKey)
  try {
    const providerPayments = await cashfreeRequest(`orders/${encodeURIComponent(payment.cashfreeOrderId)}/payments`)
    const providerPayment = (Array.isArray(providerPayments) ? providerPayments : providerPayments.payments || []).find(item => String(item.cf_payment_id) === String(payment.cashfreePaymentId))
    const expectedProviderAmount = Number(payment.batchTotalAmount || payment.amount || 0)
    if (!providerPayment || providerPayment.payment_status !== 'SUCCESS' || providerPayment.payment_currency !== 'INR' || Math.abs(Number(providerPayment.payment_amount) - expectedProviderAmount) >= 0.005) throw new Error('Cashfree has not confirmed the exact INR payment amount, so it cannot be refunded yet.')
    const providerRefunds = []
    for (const local of payment.refunds || []) {
      if (!local.id) continue
      const fetched = await cashfreeRequest(`orders/${encodeURIComponent(payment.cashfreeOrderId)}/refunds/${encodeURIComponent(local.id)}`).catch(error => {
        if (error.status === 404) return null
        throw error
      })
      if (fetched) providerRefunds.push(fetched)
    }
    for (const providerRefund of providerRefunds) {
      const local = (payment.refunds || []).find(item => item.id === String(providerRefund.refund_id)) || {}
      updateCashfreeRefundRecord(payment, providerRefund, local)
    }
    updateRefundTotals(order, payment)
    const pendingAmount = (payment.refunds || []).filter(refund => ['pending', 'initiating'].includes(refund.status)).reduce((sum, refund) => sum + Number(refund.amount || 0), 0)
    const refundable = Math.max(0, Number(payment.amount || 0) - Number(payment.amountRefunded || 0) - pendingAmount)
    const refundAmount = amount === null ? refundable : Math.min(refundable, Math.max(0, Number(amount)))
    if (refundAmount < 0.01) return { status: payment.refundStatus || 'processed', duplicate: true }
    const refund = { id: `GA${String(order.id).replace(/[^A-Za-z0-9]/g, '')}${randomUUID().replace(/-/g, '').slice(0, 10)}`.slice(0, 40) }
    Object.assign(refund, { amount: Math.round(refundAmount * 100) / 100, status: 'initiating', reason: String(reason).slice(0, 100), ...(allocationOrderId ? { allocationOrderId } : {}), createdAt: refund.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() })
    payment.refunds ||= []
    if (!payment.refunds.includes(refund)) payment.refunds.push(refund)
    updateRefundTotals(order, payment)
    persistPortalState()
    let providerRefund
    try {
      providerRefund = await cashfreeRequest(`orders/${encodeURIComponent(payment.cashfreeOrderId)}/refunds/${encodeURIComponent(refund.id)}`).catch(error => {
        if (error.status === 404) return null
        throw error
      })
      if (!providerRefund) providerRefund = await cashfreeRequest(`orders/${encodeURIComponent(payment.cashfreeOrderId)}/refunds`, {
        method: 'POST',
        body: { refund_amount: refund.amount, refund_id: refund.id, refund_note: String(reason).slice(0, 100) }
      })
    } catch (error) {
      refund.status = 'failed'
      refund.failureReason = String(error.message || 'Cashfree could not start the refund.').slice(0, 300)
      updateRefundTotals(order, payment)
      persistPortalState()
      throw error
    }
    updateCashfreeRefundRecord(payment, providerRefund, refund)
    updateRefundTotals(order, payment)
    if (payment.refundStatus !== 'failed') delete payment.refundFailureReason
    persistPortalState()
    return { status: payment.refundStatus, refund }
  } finally {
    razorpayRefundsInProgress.delete(lockKey)
  }
}
async function initiateOnlineRefund(order, payment, options = {}) {
  if (payment.provider === 'Cashfree') return initiateCashfreeRefund(order, payment, options)
  return initiateRazorpayRefund(order, payment, options)
}
function recomputeOrderPaidAmount(order) {
  const confirmed = (order.payments || []).filter(payment => ['Paid', 'Verified'].includes(payment.status))
  if (!confirmed.length) return Number(order.amountPaid || 0)
  const recordedGross = confirmed.reduce((sum, payment) => sum + Number(payment.amountApplied ?? payment.amount ?? 0), 0)
  if (!Number.isFinite(Number(order.paidBalanceAdjustment))) order.paidBalanceAdjustment = Math.max(0, Number(order.amountPaid || 0) - recordedGross)
  const amount = Number(order.paidBalanceAdjustment || 0) + confirmed.reduce((sum, payment) => sum + confirmedOrderPaymentAmount(payment, order.id), 0)
  order.amountPaid = Math.round(amount * 100) / 100
  return order.amountPaid
}
const safeFileName = value => String(value || 'document').trim().replace(/[^a-z0-9._-]+/gi, '_').replace(/^\.+|\.+$/g, '') || 'document'
function indiaDateKey(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}
function validDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
function drugLicenseExpired(expiryDate, today = indiaDateKey()) {
  return validDateKey(expiryDate) && expiryDate < today
}
function profileFrozen(profile, today = indiaDateKey()) {
  return !validDateKey(profile?.drugLicenseExpiresAt) || drugLicenseExpired(profile.drugLicenseExpiresAt, today)
}
const safeProfile = profile => {
  if (!profile) return null
  const { latestLedgerPdf, ...visible } = profile
  const expiryValid = validDateKey(profile.drugLicenseExpiresAt)
  return {
    ...visible,
    drugLicenseExpired: expiryValid && drugLicenseExpired(profile.drugLicenseExpiresAt),
    drugLicenseExpiryMissing: !expiryValid,
    profileFrozen: profileFrozen(profile)
  }
}
function dashboardAttachmentMetadata(attachments) {
  if (!attachments || typeof attachments !== 'object') return {}
  return Object.fromEntries(Object.entries(attachments).map(([key, file]) => [key, file && typeof file === 'object'
    ? { name: String(file.name || 'document'), type: String(file.type || '') }
    : null]))
}
function dashboardProfile(profile) {
  const visible = safeProfile(profile)
  return visible ? { ...visible, attachments: dashboardAttachmentMetadata(visible.attachments) } : null
}
async function blobDataUrl(blob) {
  const bytes = Buffer.from(await blob.arrayBuffer())
  return `data:application/pdf;base64,${bytes.toString('base64')}`
}
function pdfEmailAttachment(file) {
  return { filename: file.name, content: file.data.slice(file.data.indexOf(',') + 1), encoding: 'base64', contentType: 'application/pdf' }
}
async function refreshLatestLedger(profile, currentOrder) {
  if (!profile) return null
  const accountOrders = orders.filter(order => order.profileId === profile.id).sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const selectedOrder = currentOrder || accountOrders.at(-1)
  if (!selectedOrder) { profile.latestLedgerPdf = null; return null }
  const blob = createOrderLedgerPdf({ profile, currentOrder: selectedOrder, orders: accountOrders, generatedAt: new Date() })
  profile.latestLedgerPdf = {
    name: `${safeFileName(profile.shopName)}-${safeFileName(selectedOrder.id)}-profile-ledger.pdf`,
    data: await blobDataUrl(blob),
    orderId: selectedOrder.id,
    templateVersion: 2,
    updatedAt: new Date().toISOString()
  }
  return profile.latestLedgerPdf
}
async function ensureCurrentLedger(profile) {
  if (profile?.latestLedgerPdf?.templateVersion === 2) return profile.latestLedgerPdf
  const ledger = await refreshLatestLedger(profile)
  if (ledger) persistPortalState()
  return ledger
}
async function createSavedPaymentReceipt(profile, order, payment) {
  const receiptOrder = {
    ...order,
    amountDue: Number(payment.dueAtPayment ?? order.amountDue ?? 0),
    amountPaid: Number(payment.totalPaidAfter ?? order.amountPaid ?? 0)
  }
  const blob = createPaymentReceiptPdf({ profile, order: receiptOrder, payment, generatedAt: new Date() })
  return { name: `${safeFileName(order.id)}-${safeFileName(payment.id)}-receipt.pdf`, data: await blobDataUrl(blob) }
}
let emailOutboxProcessing = false
const htmlText = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const emailValue = value => htmlText(value || '—').replace(/\r?\n/g, '<br>')
function emailPlainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|tr|table|li|section)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => { const point = Number(code); return point <= 0x10ffff ? String.fromCodePoint(point) : '' })
    .replace(/&#x([\da-f]+);/gi, (_, code) => { const point = parseInt(code, 16); return point <= 0x10ffff ? String.fromCodePoint(point) : '' })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
const emailTimestamp = value => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : `${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(date)} IST`
}
function emailRows(fields) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 0">${fields.map(([label, value], index) => `<tr style="background:${index % 2 ? '#ffffff' : '#f7f8f6'}"><td valign="top" style="width:36%;padding:9px 10px;border-bottom:1px solid #e8ebe6;color:#68746c;font:12px Arial,sans-serif">${htmlText(label)}</td><td valign="top" style="padding:9px 10px;border-bottom:1px solid #e8ebe6;color:#202b27;font:12px Arial,sans-serif;font-weight:600;overflow-wrap:anywhere">${emailValue(value)}</td></tr>`).join('')}</table>`
}
function professionalEmail({ title, greeting, introduction, sections, attachmentNote }) {
  const sectionHtml = sections.map(section => `<h2 style="margin:24px 0 0;padding:0 0 9px;border-bottom:1px solid #dfe4de;color:#34443a;font:600 14px Arial,sans-serif">${htmlText(section.title)}</h2>${emailRows(section.fields)}`).join('')
  return `<!doctype html><html><body style="margin:0;padding:24px 10px;background:#f2f4f1;color:#202b27;font-family:Arial,Helvetica,sans-serif"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${htmlText(introduction)}</div><table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;border-collapse:collapse;background:#ffffff;border:1px solid #dfe4de"><tr><td style="height:6px;background:#415c50;font-size:0;line-height:0">&nbsp;</td></tr><tr><td style="padding:24px 30px 20px;border-bottom:1px solid #e7ebe5;background:#fbfcfa"><div style="color:#65746a;font:700 10px Arial,sans-serif;letter-spacing:2px">GOURI AGENCY</div><h1 style="margin:10px 0 0;color:#202b27;font:600 23px/1.3 Arial,sans-serif">${htmlText(title)}</h1></td></tr><tr><td style="padding:23px 30px 30px"><p style="margin:0 0 12px;color:#26342b;font:14px/1.6 Arial,sans-serif">Dear <strong>${htmlText(greeting || 'Customer')}</strong>,</p><p style="margin:0;color:#56635a;font:13px/1.75 Arial,sans-serif">${htmlText(introduction)}</p>${sectionHtml}<div style="margin:22px 0 0;padding:13px 15px;border:1px solid #dfe5dd;background:#f8faf7;color:#4f5f53;font:12px/1.65 Arial,sans-serif">${htmlText(attachmentNote)}</div><p style="margin:18px 0 0;color:#68746c;font:11px/1.6 Arial,sans-serif">Email serial number: <strong style="color:#26362d">{{EMAIL_SERIAL}}</strong></p><p style="margin:18px 0 0;color:#56635a;font:12px/1.7 Arial,sans-serif">Please keep this email for your records. If you need help, contact Gouri Agency at <a href="tel:8250589982" style="color:#415c50">8250589982</a> or <a href="mailto:gouriagency185@gmail.com" style="color:#415c50">gouriagency185@gmail.com</a>.</p><p style="margin:17px 0 0;padding:10px 12px;border:1px solid #e6eae4;background:#f8faf7;color:#68746c;font:11px/1.6 Arial,sans-serif">This is a system-generated email. Please do not reply to this message.</p><p style="margin:20px 0 0;color:#26342b;font:12px/1.7 Arial,sans-serif">Warm Regards,<br><strong>Gouri Agency</strong><br>Benachity, Durgapur-13</p></td></tr><tr><td style="padding:15px 30px;border-top:1px solid #e7ebe5;background:#fbfcfa;color:#7a857d;font:10px/1.6 Arial,sans-serif">1st Floor, Benachity Agrani Gali, Durgapur - 13, West Bengal, PIN 713213<br>Wholesale pharmaceutical distribution · Email notification generated automatically</td></tr></table></body></html>`
}
function standardizeQueuedEmail(html, greeting) {
  const name = greeting ? htmlText(greeting) : ''
  let standardized = String(html || '')
  if (name) standardized = standardized.replace(/(<p\b[^>]*>\s*)Dear\s*(?:<strong>)?[\s\S]*?(?:<\/strong>)?,\s*(<\/p>)/i, (_, opening, closing) => `${opening}Dear <strong>${name}</strong>,${closing}`)
  standardized = standardized
    .replace(/<p\b[^>]*>\s*(?:Regards|Warm Regards)\s*,\s*<br\s*\/?>\s*<strong>Gouri Agency<\/strong>(?:\s*<br\s*\/?>\s*Benachity,\s*Durgapur-13)?\s*<\/p>/i,
      '<p style="margin:20px 0 0;color:#26342b;font:12px/1.7 Arial,sans-serif">Warm Regards,<br><strong>Gouri Agency</strong><br>Benachity, Durgapur-13</p>')
  if (/system-generated email\. Please do not reply/i.test(standardized)) return standardized
  return standardized.replace(/(<p style="margin:20px 0 0;color:#26342b;font:12px\/1\.7 Arial,sans-serif">Warm Regards,)/i,
    '<p style="margin:17px 0 0;padding:10px 12px;border:1px solid #e6eae4;background:#f8faf7;color:#68746c;font:11px/1.6 Arial,sans-serif">This is a system-generated email. Please do not reply to this message.</p>$1')
}
function enqueueTransactionalEmail({ idempotencyKey, to, ccEmails, subject, html, attachments, orderId, paymentId, profileId, emailType }) {
  const existing = emailOutbox.find(job => job.idempotencyKey === idempotencyKey)
  if (existing) return existing
  const serial = reserveEmailSerial()
  const job = {
    id: randomUUID(), idempotencyKey, serial, to,
    ccEmails: Array.isArray(ccEmails) ? [...new Set(ccEmails.map(normalizeEmailAddress).filter(address => emailAddressPattern.test(address)))].slice(0, 20) : [],
    subject: `${subject} | SR No. ${serial}`,
    html: html.replaceAll('{{EMAIL_SERIAL}}', serial), attachments,
    orderId: orderId || null, paymentId: paymentId || null, profileId: profileId || null, emailType: emailType || null,
    status: EMAIL_CONFIGURED ? 'pending' : 'needs_configuration',
    attempts: 0, createdAt: new Date().toISOString(), nextAttemptAt: new Date().toISOString()
  }
  emailOutbox.unshift(job)
  persistPortalState()
  if (EMAIL_CONFIGURED) setImmediate(() => { processEmailOutbox().catch(() => {}) })
  return job
}
async function processEmailOutbox() {
  if (!EMAIL_CONFIGURED || emailOutboxProcessing) return
  emailOutboxProcessing = true
  try {
    await persistenceTail
    for (const job of emailOutbox) {
      if (!['pending', 'retry'].includes(job.status) || Date.parse(job.nextAttemptAt || 0) > Date.now()) continue
      if (job.emailType === 'due_reminder') {
        const reminderProfile = [...profilesByGst.values()].find(profile => profile.id === job.profileId)
        const stillOwes = orders.some(order => order.profileId === job.profileId && order.status !== 'Cancelled' && Number(order.amountDue || 0) - Number(order.amountPaid || 0) > 0.005)
        if (!paymentSettings.dueReminders.enabled || !reminderProfile || !stillOwes) {
          job.status = 'cancelled'
          job.cancelledAt = new Date().toISOString()
          await persistPortalState()
          continue
        }
      }
      try {
        const ccEmails = [...new Set([...(job.ccEmails || []), ...emailSettings.ccEmails].map(normalizeEmailAddress).filter(address => address && address !== normalizeEmailAddress(job.to)))].slice(0, 20)
        const result = await mailTransport.sendMail({
          from: { name: emailSettings.fromName, address: emailSettings.fromAddress },
          to: job.to,
          cc: ccEmails,
          replyTo: { name: emailSettings.fromName, address: GMAIL_USER },
          subject: job.subject,
          html: job.html,
          text: emailPlainText(job.html),
          headers: { 'X-Gouri-Email-Serial': job.serial || '' },
          attachments: (job.attachments || []).map(file => ({ ...file, encoding: file.encoding || 'base64' }))
        })
        const acceptedRecipients = Array.isArray(result.accepted) ? result.accepted.map(recipient => String(typeof recipient === 'string' ? recipient : recipient?.address || '').toLowerCase()) : []
        const expectedRecipient = String(job.to || '').toLowerCase()
        if (Array.isArray(result.rejected) && result.rejected.length) throw new Error('Gmail SMTP rejected the recipient address.')
        if (!acceptedRecipients.includes(expectedRecipient)) throw new Error('Gmail SMTP did not confirm acceptance of the recipient address.')
        job.status = 'sent'; job.providerId = result.messageId || ''; job.sentAt = new Date().toISOString(); delete job.lastError
      } catch (error) {
        job.attempts = Number(job.attempts || 0) + 1
        job.lastError = String(error.message || 'Gmail SMTP delivery failed.').slice(0, 240)
        if (job.attempts >= 12) job.status = 'failed'
        else {
          job.status = 'retry'
          job.nextAttemptAt = new Date(Date.now() + Math.min(60 * 60 * 1000, 5000 * (2 ** Math.min(job.attempts - 1, 8)))).toISOString()
        }
      }
      const relatedOrder = job.orderId ? orders.find(order => order.id === job.orderId) : null
      if (relatedOrder && !job.paymentId) relatedOrder.emailStatus = job.status
      if (relatedOrder && job.paymentId) {
        const payment = (relatedOrder.payments || []).find(item => item.id === job.paymentId)
        if (payment) payment.emailStatus = job.status
      }
      await persistPortalState()
    }
  } finally { emailOutboxProcessing = false }
}
function communicationMessageForDashboard(message) {
  const emailJob = emailOutbox.find(job => job.id === message.emailJobId)
  return { ...message, deliveryStatus: emailJob?.status || message.deliveryStatus || 'saved', deliveredAt: emailJob?.sentAt || '' }
}
function communicationThreadForProfile(profileId) {
  return communicationMessages
    .filter(message => message.profileId === profileId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map(communicationMessageForDashboard)
}
function queueCommunicationMessage({ profile, senderRole, senderName, senderEmail, to, ccEmails = [], subject, body, upload }) {
  const id = randomUUID()
  const attachment = upload ? {
    filename: safeFileName(upload.name),
    content: upload.data.slice(upload.data.indexOf(',') + 1),
    encoding: 'base64',
    contentType: upload.type
  } : null
  const message = {
    id, profileId: profile.id, senderRole, senderName, senderEmail, to,
    ccEmails, subject, body,
    attachment: attachment ? { filename: attachment.filename, contentType: attachment.contentType } : null,
    emailJobId: '', createdAt: new Date().toISOString(), deliveryStatus: EMAIL_CONFIGURED ? 'pending' : 'needs_configuration'
  }
  communicationMessages.unshift(message)
  const clientName = profile.ownerName || profile.shopName
  const isClientMessage = senderRole === 'client'
  const sections = isClientMessage
    ? [{ title: 'Client message', fields: [['Client / pharmacy', profile.shopName], ['Registered email', profile.email], ['Mobile number', profile.mobile], ['GST number', profile.gstNumber], ['Subject', subject], ['Message', body]] }]
    : [{ title: 'Message', fields: [['Subject', subject], ['Message', body]] }]
  const html = professionalEmail({
    title: subject,
    greeting: isClientMessage ? 'Gouri Agency team' : clientName,
    introduction: isClientMessage
      ? `${clientName} sent a message from the client portal. Reply to this client from the portal communications thread.`
      : `Gouri Agency sent a message to ${profile.shopName} through the client portal.`,
    sections,
    attachmentNote: attachment ? `Attached document: ${attachment.filename}` : 'No document was attached to this message.'
  })
  const emailJob = enqueueTransactionalEmail({
    idempotencyKey: `communication/${id}`,
    to,
    ccEmails,
    subject: `Gouri Agency | ${subject}`,
    html,
    attachments: attachment ? [attachment] : [],
    profileId: profile.id,
    emailType: 'communication_message'
  })
  message.emailJobId = emailJob.id
  message.subject = emailJob.subject
  message.deliveryStatus = emailJob.status
  persistPortalState()
  return communicationMessageForDashboard(message)
}
function sendCommunicationAttachment(res, message) {
  const emailJob = emailOutbox.find(job => job.id === message.emailJobId)
  const attachment = emailJob?.attachments?.[0]
  if (!attachment?.content || !['application/pdf', 'image/jpeg', 'image/png'].includes(attachment.contentType)) return json(res, 404, { error: 'This message attachment is not available.' })
  const bytes = Buffer.from(attachment.content, 'base64')
  res.writeHead(200, {
    'Content-Type': attachment.contentType,
    'Content-Length': bytes.length,
    'Content-Disposition': `attachment; filename="${safeFileName(attachment.filename)}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(bytes)
}
function validateCommunicationPayload(body) {
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
  const messageBody = typeof body.body === 'string' ? body.body.trim() : ''
  const upload = body.attachment || null
  if (!subject || subject.length > 180 || /[\r\n\x00-\x1f]/.test(subject)) return { error: 'Enter a subject of up to 180 characters.' }
  if (!messageBody || messageBody.length > 12000) return { error: 'Enter a message of up to 12,000 characters.' }
  if (upload && !validUpload(upload, ['application/pdf', 'image/jpeg', 'image/png'])) return { error: 'Attach a valid PDF, JPG, or PNG file up to 5 MB.' }
  return { subject, body: messageBody, upload }
}
function queueOrderLedgerEmail(profile, order, ledger) {
  const customerName = profile.ownerName || profile.shopName
  const documents = [
    ['Owner photo', order.attachments?.profilePhoto],
    ['Drug license', order.attachments?.drugLicense],
    ['GST copy', order.attachments?.gstCopy],
    ['Authorized signature', order.attachments?.signature]
  ].map(([label, file]) => [label, file?.name || 'Not supplied'])
  const profileFields = [
    ['Profile ID', profile.id], ['Shop / pharmacy name', profile.shopName], ['Business type', profile.businessType],
    ['Owner name', profile.ownerName || 'Not applicable'], ['Partner 1', profile.partnerOne || 'Not applicable'], ['Partner 2', profile.partnerTwo || 'Not applicable'],
    ['Registered email', profile.email], ['Mobile number', profile.mobile], ['Shop address', profile.shopAddress],
    ['GST number', profile.gstNumber], ['Drug license number', profile.drugLicenseNumber],
    ['Drug license expiry date', profile.drugLicenseExpiresAt || 'Not recorded']
  ]
  const orderFields = [
    ['Order number', order.id], ['Submitted at', emailTimestamp(order.date)], ['Order status', order.status],
    ['Authorized signatory', order.authorizedSignatoryName || order.ownerName || 'Not recorded'],
    ['Drug license expiry date', order.drugLicenseExpiresAt || profile.drugLicenseExpiresAt || 'Not recorded'],
    ['Products / quantities', (order.items || []).map(item => `${item.name} — ${item.quantity}`).join('\n') || 'None'],
    ['Remarks', order.remarks || 'None'], ['Declaration accepted', order.declarationAccepted ? `Yes — ${emailTimestamp(order.declarationAcceptedAt || order.date)}` : 'No']
  ]
  return enqueueTransactionalEmail({
    idempotencyKey: `order-ledger/${order.id}`,
    to: profile.email,
    subject: `Gouri Agency | Order ${order.id} received`,
    html: professionalEmail({
      title: 'Order request received', greeting: customerName,
      introduction: `We have received your order request for ${profile.shopName}. It is recorded as ${order.status} and is awaiting review by Gouri Agency.`,
      sections: [{ title: 'Registered customer details', fields: profileFields }, { title: 'Order details', fields: orderFields }, { title: 'Documents received with this order', fields: documents }],
      attachmentNote: `Attached is the generated order and customer profile PDF for order ${order.id}. It includes the pre-order declaration, your recorded acceptance, and the extracted authorized signature.`
    }),
    attachments: [pdfEmailAttachment(ledger)], orderId: order.id
  })
}
function queuePaymentConfirmationEmail(profile, order, payment, ledger, receipt) {
  const customerName = profile.ownerName || profile.shopName
  const balance = order.status === 'Cancelled' ? 0 : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0))
  return enqueueTransactionalEmail({
    idempotencyKey: `payment-receipt/${payment.id}`,
    to: profile.email,
    subject: `Gouri Agency | Payment recorded for ${order.id}`,
    html: professionalEmail({
      title: 'Payment confirmation', greeting: customerName,
      introduction: `A payment for order ${order.id} has been recorded in your Gouri Agency account.`,
      sections: [
        { title: 'Payment details', fields: [['Order number', order.id], ['Transaction amount received', formatINR(payment.amount)], ['Applied to this order', formatINR(payment.amountApplied ?? payment.amount)], ['Carried to other open bills', (payment.allocations || []).filter(row => row.role === 'carry-forward').map(row => `${row.orderId}: ${formatINR(row.amount)}`).join('; ') || 'None'], ['Payment method', payment.provider || 'Payment'], ['Transaction reference', payment.reference || payment.razorpayPaymentId || payment.razorpayOrderId || payment.cashfreePaymentId || payment.cashfreeOrderId || '—'], ['Payment date and time', emailTimestamp(payment.paidAt || payment.reviewedAt)] ] },
        { title: 'Updated order balance', fields: [['Total order due', formatINR(order.amountDue)], ['Total paid', formatINR(order.amountPaid)], ['Outstanding balance', formatINR(balance)], ['Last payment date and time', emailTimestamp(order.lastPaymentAt || payment.paidAt)] ] }
      ],
      attachmentNote: 'Attached are your payment receipt and updated order/customer profile PDF. These documents are also available from your client portal.'
    }),
    attachments: [pdfEmailAttachment(receipt), pdfEmailAttachment(ledger)], orderId: order.id, paymentId: payment.id
  })
}
function queueProfileUpdateEmail(profile, changedFields, ledger, options = {}) {
  const customerName = profile.ownerName || profile.shopName
  const attachments = ledger ? [pdfEmailAttachment(ledger)] : []
  const title = options.title || 'Customer profile updated'
  const introduction = options.introduction || 'A change has been saved to your customer profile. Please review the updated details below.'
  const attachmentNote = options.attachmentNote || (ledger ? 'Your latest order and customer profile PDF is attached for your records.' : 'No order PDF is available for this profile yet.')
  const html = professionalEmail({
    title, greeting: customerName, introduction,
    sections: [{ title: options.sectionTitle || 'Fields updated', fields: changedFields }],
    attachmentNote
  })
  const emailJob = enqueueTransactionalEmail({
    idempotencyKey: `profile-update/${profile.id}/${profile.updatedAt || Date.now()}`,
    to: profile.email,
    subject: `Gouri Agency | ${title} for ${profile.shopName}`,
    html,
    attachments, profileId: profile.id
  })
  const previousEmail = String(options.previousEmail || '').trim().toLowerCase()
  const currentEmail = String(profile.email || '').trim().toLowerCase()
  if (previousEmail && previousEmail !== currentEmail) {
    enqueueTransactionalEmail({
      idempotencyKey: `profile-update-previous-email/${profile.id}/${profile.updatedAt || Date.now()}`,
      to: previousEmail,
      subject: `Gouri Agency | ${title} for ${profile.shopName}`,
      html,
      attachments: [], profileId: profile.id
    })
  }
  return emailJob
}
function queueOrderUpdateEmail(profile, order, changedFields, ledger, options = {}) {
  const customerName = profile?.ownerName || profile?.shopName || order.ownerName || order.shopName
  return enqueueTransactionalEmail({
    idempotencyKey: `order-update/${order.id}/${order.updatedAt}`,
    to: profile?.email || order.email,
    subject: `Gouri Agency | Order ${order.id} updated`,
    html: professionalEmail({
      title: 'Order details updated', greeting: customerName,
      introduction: options.introduction || `Gouri Agency has updated information for your order ${order.id}. The changed details are listed below.`,
      sections: [{ title: 'Updated order fields', fields: [['Order number', order.id], ['Updated at', emailTimestamp(order.updatedAt)], ...changedFields] }],
      attachmentNote: ledger ? `The latest order and profile PDF for ${order.id} is attached.` : (options.attachmentNote || `Order ${order.id} was rejected and removed from the active order list.`)
    }),
    attachments: ledger ? [pdfEmailAttachment(ledger)] : [], orderId: order.id
  })
}
const razorpayRefundsInProgress = new Set()
const PAYMENT_RECONCILIATION_WINDOW_MS = 24 * 60 * 60 * 1000
async function emailPaymentStateChange(order, title, fields, introduction) {
  const profile = [...profilesByGst.values()].find(item => item.id === order.profileId)
  order.updatedAt = new Date().toISOString()
  const ledger = profile ? await refreshLatestLedger(profile, order) : null
  const emailJob = queueOrderUpdateEmail(profile, order, fields, ledger, { introduction, attachmentNote: `${title} for order ${order.id}.` })
  order.emailStatus = emailJob.status
  persistPortalState()
  return emailJob
}
function orderCancellationWindow(order, now = Date.now()) {
  if (order.status === 'Cancelled') return { eligible: false, reason: 'This order is already cancelled.' }
  if (order.approvedAt || ['Approved', 'Rejected', 'Complete'].includes(order.status)) {
    return { eligible: false, reason: 'Cancellation is closed after an order is approved or rejected.' }
  }
  if (!['In progress', 'Pending approval'].includes(order.status)) {
    return { eligible: false, reason: 'Cancellation is available only while the order is in progress.' }
  }
  const createdAt = Date.parse(order.date || order.createdAt || '')
  if (!Number.isFinite(createdAt) || now >= createdAt + DAY_MS) {
    return { eligible: false, reason: 'The 24-hour cancellation period has ended.' }
  }
  return { eligible: true, reason: '' }
}
const orderCancellationsInProgress = new Set()
const onlinePaymentProviders = new Set(['Razorpay', 'Cashfree'])
function isGatewayPayment(payment) { return onlinePaymentProviders.has(payment?.provider) }
function gatewayDisplayName(payment) { return payment?.provider === 'Cashfree' ? 'Cashfree' : 'Razorpay' }
async function reallocateCancelledAccountCredit(order, creditPayment) {
  const sourceOrder = orders.find(item => item.id === creditPayment.sourceOrderId && item.profileId === order.profileId)
  const sourcePayment = sourceOrder?.payments?.find(item => item.id === creditPayment.sourcePaymentId)
  if (!sourceOrder || !sourcePayment) {
    creditPayment.refundStatus = 'manual_review'
    creditPayment.refundFailureReason = 'The source payment record for this account credit could not be found. Agency review is required.'
    return { manualReview: Number(creditPayment.amountApplied ?? creditPayment.amount ?? 0) }
  }
  const movable = Math.max(0, Number(creditPayment.amountApplied ?? creditPayment.amount ?? 0) - Number(creditPayment.amountRefunded || 0))
  sourcePayment.allocations = (sourcePayment.allocations || []).filter(row => row.orderId !== order.id || row.paymentId !== creditPayment.id)
  creditPayment.allocationOriginalAmount = movable
  creditPayment.status = 'Transferred'
  creditPayment.amountApplied = 0
  creditPayment.reallocatedAt = new Date().toISOString()
  creditPayment.reference = `${creditPayment.reference || `Credit from ${sourceOrder.id}`} · order cancelled`
  order.amountPaid = Math.max(0, Number(order.amountPaid || 0) - movable)
  let remaining = movable
  const movedTo = []
  for (const destination of carryForwardOrderCandidates(sourceOrder)) {
    const available = Math.max(0, Number(destination.amountDue || 0) - Number(destination.amountPaid || 0) - reservedPaymentTotal(destination))
    const applied = Math.round(Math.min(remaining, available) * 100) / 100
    if (applied <= 0) continue
    const movedCredit = addAccountCredit(sourceOrder, sourcePayment, destination, applied)
    movedTo.push({ orderId: destination.id, amount: applied, paymentId: movedCredit.id })
    remaining = Math.round((remaining - applied) * 100) / 100
    if (remaining <= 0.005) break
  }
  let refundStarted = 0
  let manualReview = 0
  if (remaining > 0.005 && isGatewayPayment(sourcePayment)) {
    creditPayment.status = 'Paid'
    creditPayment.amount = remaining
    creditPayment.amountApplied = remaining
    creditPayment.refundStatus = 'pending'
    try {
      await initiateOnlineRefund(sourceOrder, sourcePayment, {
        amount: remaining,
        allocationOrderId: order.id,
        reason: `Return carry-forward credit after order ${order.id} was cancelled`,
        suffix: `credit-${order.id}-${Date.now()}`
      })
      refundStarted = remaining
    } catch (error) {
      creditPayment.refundStatus = 'failed'
      creditPayment.refundFailureReason = String(error.message || 'The carry-forward refund could not be started.').slice(0, 300)
      manualReview = remaining
    }
  } else if (remaining > 0.005) {
    creditPayment.status = 'Paid'
    creditPayment.amount = remaining
    creditPayment.amountApplied = remaining
    creditPayment.refundStatus = 'manual_review'
    creditPayment.refundFailureReason = 'The agency must review this bank-transfer account credit for manual refund or future bill adjustment.'
    creditPayment.refunds ||= []
    creditPayment.refunds.push({ id: `MANUAL-${randomUUID().replace(/-/g, '').slice(0, 10)}`, amount: remaining, status: 'manual_review', reason: 'Cancelled order account credit', allocationOrderId: order.id, createdAt: new Date().toISOString() })
    manualReview = remaining
  } else {
    creditPayment.amount = Number(creditPayment.allocationOriginalAmount || creditPayment.amount || 0)
  }
  creditPayment.creditMovedAmount = Math.round(movedTo.reduce((sum, row) => sum + row.amount, 0) * 100) / 100
  creditPayment.creditMovedTo = movedTo
  refreshPaymentAllocationSummary(sourcePayment)
  recomputeOrderPaidAmount(order)
  recomputeOrderPaidAmount(sourceOrder)
  return { moved: Math.round((movable - remaining) * 100) / 100, refundStarted, manualReview }
}
async function cancelOrderAndRequestRefund(order, cancelledBy) {
  if (orderCancellationsInProgress.has(order.id)) return { statusCode: 409, error: 'Cancellation is already being processed for this order. Refresh the order shortly.' }
  orderCancellationsInProgress.add(order.id)
  try { return await performOrderCancellation(order, cancelledBy) }
  finally { orderCancellationsInProgress.delete(order.id) }
}
async function performOrderCancellation(order, cancelledBy) {
  const eligibility = orderCancellationWindow(order)
  if (!eligibility.eligible) return { statusCode: 409, error: eligibility.reason }
  if ((order.payments || []).some(payment => payment.status === 'Pending verification')) {
    return { statusCode: 409, error: 'A bank transfer is awaiting agency confirmation. Contact the agency to reconcile it before cancelling this order.' }
  }
  if ((order.payments || []).some(payment => payment.status === 'Verified')) {
    return { statusCode: 409, error: 'A confirmed bank transfer cannot be refunded automatically through an online gateway. Contact the agency to reconcile this order.' }
  }
  const brokenCredit = (order.payments || []).find(payment => payment.provider === 'Account credit' && (!orders.some(item => item.id === payment.sourceOrderId && item.profileId === order.profileId && item.payments?.some(source => source.id === payment.sourcePaymentId))))
  if (brokenCredit) return { statusCode: 409, error: 'This order has a carry-forward credit whose original payment record needs agency review before cancellation.' }
  const recordedOnlinePaid = (order.payments || []).filter(payment => isGatewayPayment(payment) && payment.status === 'Paid').reduce((sum, payment) => sum + confirmedOrderPaymentAmount(payment, order.id), 0)
  const recordedCarryForwardPaid = (order.payments || []).filter(payment => payment.provider === 'Account credit' && payment.status === 'Paid').reduce((sum, payment) => sum + confirmedOrderPaymentAmount(payment, order.id), 0)
  if (Number(order.amountPaid || 0) - recordedOnlinePaid - recordedCarryForwardPaid > 0.005) {
    return { statusCode: 409, error: 'This order has a payment balance that cannot be traced to a verified online transaction. Contact the agency to review it before cancelling.' }
  }
  try {
    for (const payment of (order.payments || []).filter(row => isGatewayPayment(row) && ['Awaiting Razorpay payment', 'Razorpay payment processing', 'Awaiting Cashfree payment', 'Cashfree payment processing', 'Failed', 'Cancelled'].includes(row.status) && (row.razorpayOrderId || row.cashfreeOrderId))) {
      if (['Awaiting Razorpay payment', 'Awaiting Cashfree payment'].includes(payment.status)) {
        const collection = payment.provider === 'Cashfree'
          ? await cashfreeRequest(`orders/${encodeURIComponent(payment.cashfreeOrderId)}/payments`)
          : await razorpayRequest(`orders/${encodeURIComponent(payment.razorpayOrderId)}/payments?count=100`)
        const attempts = Array.isArray(collection) ? collection : collection.items || collection.payments || []
        if (!attempts.length) {
          payment.status = 'Cancelled'
          payment.cancelledAt = new Date().toISOString()
          payment.reconcileUntil = new Date(Date.now() + PAYMENT_RECONCILIATION_WINDOW_MS).toISOString()
          payment.nextReconcileAt = new Date(Date.now() + 5 * 60_000).toISOString()
          persistPortalState()
          continue
        }
      }
      await reconcileOnlinePayment(order, payment)
    }
  } catch (error) {
    return { statusCode: 502, error: `The latest online payment is still being checked. Please retry cancellation shortly. ${error.message || ''}`.trim() }
  }
  if ((order.payments || []).some(payment => ['Awaiting Razorpay payment', 'Razorpay payment processing', 'Awaiting Cashfree payment', 'Cashfree payment processing'].includes(payment.status))) {
    return { statusCode: 409, error: 'An online payment is still being confirmed. Your order has not been cancelled; wait a moment and try again.' }
  }
  // Recheck after network calls so an approval or expired 24-hour window cannot race a refund request.
  const finalEligibility = orderCancellationWindow(order)
  if (!finalEligibility.eligible) return { statusCode: 409, error: finalEligibility.reason }
  order.status = 'Cancelled'
  order.cancelledAt = new Date().toISOString()
  order.cancelledBy = cancelledBy
  order.updatedAt = order.cancelledAt
  persistPortalState()
  const refundErrors = []
  for (const creditPayment of (order.payments || []).filter(row => row.provider === 'Account credit' && row.status === 'Paid')) {
    const result = await reallocateCancelledAccountCredit(order, creditPayment)
    if (result.manualReview > 0.005) refundErrors.push(`${formatINR(result.manualReview)} account credit needs agency review.`)
  }
  for (const payment of (order.payments || []).filter(row => isGatewayPayment(row) && row.status === 'Paid' && (row.razorpayPaymentId || row.cashfreePaymentId))) {
    const pendingForOrder = (payment.refunds || []).filter(refund => ['pending', 'initiating'].includes(refund.status) && (!refund.allocationOrderId || refund.allocationOrderId === order.id)).reduce((sum, refund) => sum + Number(refund.amount || 0), 0)
    const sourcePaid = Math.max(0, Number(payment.amountApplied ?? payment.amount ?? 0) - paymentRefundedForOrder(payment, order.id) - pendingForOrder)
    if (sourcePaid < 0.01) continue
    try { await initiateOnlineRefund(order, payment, { amount: sourcePaid, allocationOrderId: order.id, reason: `${cancelledBy} cancelled order ${order.id}`, suffix: 'cancel' }) }
    catch (error) { payment.refundStatus = 'failed'; payment.refundFailureReason = String(error.message || `${gatewayDisplayName(payment)} refund could not be started.`).slice(0, 300); refundErrors.push(payment.refundFailureReason) }
  }
  recomputeOrderPaidAmount(order)
  const paidOnline = (order.payments || []).some(payment => payment.status === 'Paid' && isGatewayPayment(payment))
  const refundProviderNames = [...new Set((order.payments || []).filter(payment => payment.refundStatus && (isGatewayPayment(payment) || payment.originalProvider)).map(payment => payment.originalProvider || gatewayDisplayName(payment)))].join(' and ')
  const refundStates = (order.payments || []).filter(payment => payment.refundStatus).map(payment => payment.refundStatus)
  const movedCreditNote = (order.payments || []).filter(payment => payment.creditMovedAmount > 0).map(payment => `${formatINR(payment.creditMovedAmount)} account credit moved to ${(payment.creditMovedTo || []).map(row => row.orderId).join(', ')}.`).join(' ')
  const refundStatusSummary = refundStates.includes('failed') ? 'Refund failed — the agency must review the payment.' : refundStates.includes('manual_review') ? 'Account credit needs agency review for manual refund or future bill adjustment.' : refundStates.includes('pending') ? `Refund initiated — ${refundProviderNames || 'payment provider'} is processing it.` : refundStates.includes('processed') || refundStates.includes('partially_refunded') ? `Refund processed by ${refundProviderNames || 'the payment provider'}.` : paidOnline ? 'Refund requested.' : movedCreditNote ? '' : 'No successful payment was recorded; no refund was required.'
  const refundSummary = [refundStatusSummary, movedCreditNote].filter(Boolean).join(' ')
  const fields = [['Order status', `Cancelled by ${cancelledBy.toLowerCase()}`], ['Cancellation time', emailTimestamp(order.cancelledAt)], ['Payment and refund status', refundSummary], ['Outstanding balance', formatINR(0)]]
  for (const payment of (order.payments || []).filter(item => item.refundStatus)) {
    const requestedRefund = (payment.refunds || []).reduce((sum, refund) => sum + Number(refund.amount || 0), 0)
    fields.push([`Refund for ${payment.id}`, `${payment.refundStatus}; ${formatINR(requestedRefund)} requested, ${formatINR(payment.amountRefunded || 0)} returned`])
    for (const refund of payment.refunds || []) fields.push([`${gatewayDisplayName(payment)} refund reference`, refund.id || refund.receipt || 'Submitted'])
  }
  if (refundErrors.length) fields.push(['Refund review', refundErrors.join(' ')])
  const accountProfile = [...profilesByGst.values()].find(item => item.id === order.profileId)
  if (accountProfile) await refreshLatestLedger(accountProfile, order)
  persistPortalState()
  const emailJob = await emailPaymentStateChange(order, 'Order cancelled and payment reviewed', fields, `Your cancellation for order ${order.id} has been recorded. The payment and refund status is listed below.`)
  return { order, refundSummary, emailStatus: emailJob.status }
}
async function markRazorpayRefundFailed(order, payment, error, { notify = false } = {}) {
  payment.refundStatus = 'failed'
  const provider = gatewayDisplayName(payment)
  payment.refundFailureReason = String(error?.message || error || `${provider} could not process this refund.`).slice(0, 300)
  persistPortalState()
  if (notify) await emailPaymentStateChange(order, 'Refund needs agency review', [['Payment provider', provider], ['Payment reference', payment.razorpayPaymentId || payment.cashfreePaymentId], ['Refund status', 'Failed'], ['Reason', payment.refundFailureReason]], `${provider} could not complete the refund for order ${order.id}. The agency has been notified to review the payment.`)
}
function updateRefundTotals(order, payment) {
  payment.refunds ||= []
  payment.amountRefunded = Math.round(payment.refunds.filter(refund => refund.status === 'processed').reduce((sum, refund) => sum + Number(refund.amount || 0), 0) * 100) / 100
  const hasPending = payment.refunds.some(refund => ['pending', 'initiating'].includes(refund.status))
  const hasFailed = payment.refunds.some(refund => refund.status === 'failed')
  payment.refundStatus = hasPending ? 'pending' : payment.amountRefunded >= Number(payment.amount || 0) - 0.005 ? 'processed' : hasFailed ? 'failed' : payment.amountRefunded > 0 ? 'partially_refunded' : ''
  recomputeOrderPaidAmount(order)
  for (const refund of payment.refunds) {
    if (!refund.allocationOrderId) continue
    const allocatedOrder = orders.find(item => item.id === refund.allocationOrderId && item.profileId === order.profileId)
    const credit = allocatedOrder?.payments?.find(item => item.provider === 'Account credit' && item.sourceOrderId === order.id && item.sourcePaymentId === payment.id && item.allocationKind === 'carry-forward')
    if (!credit) continue
    credit.refunds ||= []
    const mirrored = credit.refunds.find(item => item.id === refund.id || (refund.receipt && item.receipt === refund.receipt)) || {}
    Object.assign(mirrored, refund)
    if (!credit.refunds.includes(mirrored)) credit.refunds.push(mirrored)
    credit.amountRefunded = Math.round(credit.refunds.filter(item => item.status === 'processed').reduce((sum, item) => sum + Number(item.amount || 0), 0) * 100) / 100
    const creditPending = credit.refunds.some(item => ['pending', 'initiating'].includes(item.status))
    const creditFailed = credit.refunds.some(item => item.status === 'failed')
    credit.refundStatus = creditPending ? 'pending' : credit.amountRefunded >= Number(credit.amountApplied ?? credit.amount ?? 0) - 0.005 ? 'processed' : creditFailed ? 'failed' : credit.amountRefunded > 0 ? 'partially_refunded' : ''
    if (creditFailed) credit.refundFailureReason = refund.failureReason || 'The payment provider could not process this refund.'
    else if (refund.status === 'processed') delete credit.refundFailureReason
    recomputeOrderPaidAmount(allocatedOrder)
  }
  const profile = [...profilesByGst.values()].find(item => item.id === order.profileId)
  if (profile?.latestLedgerPdf) profile.latestLedgerPdf.templateVersion = 0
}
async function initiateRazorpayRefund(order, payment, { amount = null, reason = 'Client order cancellation', suffix = 'cancel', allocationOrderId = '' } = {}) {
  if (payment.provider !== 'Razorpay' || !payment.razorpayPaymentId) throw new Error('Only a captured Razorpay payment can be refunded automatically.')
  const lockKey = `${order.id}/${payment.id}`
  if (razorpayRefundsInProgress.has(lockKey)) return { status: payment.refundStatus || 'pending', duplicate: true }
  razorpayRefundsInProgress.add(lockKey)
  try {
    const providerPayment = await razorpayRequest(`payments/${encodeURIComponent(payment.razorpayPaymentId)}`)
    if (providerPayment.status !== 'captured' && providerPayment.status !== 'refunded') throw new Error('Razorpay has not confirmed this payment as captured, so it cannot be refunded yet.')
    payment.refunds ||= []
    const refundsResponse = await razorpayRequest(`payments/${encodeURIComponent(payment.razorpayPaymentId)}/refunds?count=100`).catch(() => ({ items: [] }))
    const providerRefunds = Array.isArray(refundsResponse.items) ? refundsResponse.items : []
    const receiptPrefix = `GA-${order.id}-${payment.id}-`
    for (const refund of providerRefunds) {
      const local = payment.refunds.find(item => item.id === refund.id || (item.receipt && item.receipt === refund.receipt))
      if (!local && !String(refund.receipt || '').startsWith(receiptPrefix)) continue
      const matchingRefund = local || {}
      Object.assign(matchingRefund, { id: refund.id, receipt: refund.receipt || matchingRefund.receipt || '', amount: Number(refund.amount || 0) / 100, status: refund.status || matchingRefund.status || 'pending', reason: matchingRefund.reason || 'Existing Razorpay refund', updatedAt: new Date().toISOString() })
      if (!payment.refunds.includes(matchingRefund)) payment.refunds.push(matchingRefund)
    }
    updateRefundTotals(order, payment)
    const pendingAmount = payment.refunds.filter(refund => ['pending', 'initiating'].includes(refund.status)).reduce((sum, refund) => sum + Number(refund.amount || 0), 0)
    const refundable = Math.max(0, Number(payment.amount || 0) - Number(payment.amountRefunded || 0) - pendingAmount)
    const refundAmount = amount === null ? refundable : Math.min(refundable, Math.max(0, Number(amount)))
    if (refundAmount < 0.01) return { status: payment.refundStatus || 'processed', duplicate: true }
    const receipt = `GA-${order.id}-${payment.id}-${suffix}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
    let refund = providerRefunds.find(item => item.receipt === receipt)
    if (!refund) {
      const local = payment.refunds.find(item => item.receipt === receipt)
      if (local?.id) refund = await razorpayRequest(`refunds/${encodeURIComponent(local.id)}`).catch(() => null)
    }
    if (!refund) {
      const local = payment.refunds.find(item => item.receipt === receipt)
      if (local && local.status === 'failed') payment.refunds.splice(payment.refunds.indexOf(local), 1)
      const pending = { receipt, amount: Math.round(refundAmount * 100) / 100, status: 'initiating', reason, ...(allocationOrderId ? { allocationOrderId } : {}), createdAt: new Date().toISOString() }
      payment.refunds.push(pending)
      updateRefundTotals(order, payment)
      persistPortalState()
      try {
        refund = await razorpayRequest(`payments/${encodeURIComponent(payment.razorpayPaymentId)}/refund`, {
          method: 'POST',
          body: { amount: Math.round(refundAmount * 100), speed: 'normal', receipt, notes: { portal_order_id: order.id, ...(allocationOrderId ? { allocation_order_id: allocationOrderId } : {}), reason: String(reason).slice(0, 200) } }
        })
      } catch (error) {
        pending.status = 'failed'
        pending.failureReason = String(error.message || 'Razorpay could not start this refund.').slice(0, 300)
        updateRefundTotals(order, payment)
        persistPortalState()
        throw error
      }
    }
    payment.refunds ||= []
    const localRefund = payment.refunds.find(item => item.id === refund.id || item.receipt === receipt) || {}
    Object.assign(localRefund, { id: refund.id || localRefund.id, receipt: refund.receipt || receipt, amount: Number(refund.amount || Math.round(refundAmount * 100)) / 100, status: refund.status || 'pending', reason, ...(allocationOrderId ? { allocationOrderId } : {}), createdAt: localRefund.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() })
    if (!payment.refunds.includes(localRefund)) payment.refunds.push(localRefund)
    updateRefundTotals(order, payment)
    if (payment.refundStatus !== 'failed') delete payment.refundFailureReason
    persistPortalState()
    return { status: payment.refundStatus, refund: localRefund }
  } finally {
    razorpayRefundsInProgress.delete(lockKey)
  }
}
async function markRazorpayPaymentFailed(order, payment, providerPayment, reason = '') {
  const changed = payment.status !== 'Failed'
  payment.status = 'Failed'
  payment.razorpayPaymentId = providerPayment?.id || payment.razorpayPaymentId || ''
  payment.failureReason = String(reason || providerPayment?.error_description || 'Razorpay did not capture this payment.').slice(0, 300)
  payment.failedAt ||= new Date().toISOString()
  payment.reconcileUntil ||= new Date(Date.now() + PAYMENT_RECONCILIATION_WINDOW_MS).toISOString()
  payment.nextReconcileAt = new Date(Date.now() + 5 * 60_000).toISOString()
  if (changed) {
    await emailPaymentStateChange(order, 'Payment failed', [['Payment status', 'Failed'], ['Reason', payment.failureReason], ['Order balance', formatINR(Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0)))]], `Razorpay did not confirm payment for order ${order.id}. The unpaid balance remains due; you can retry from your client portal.`)
  }
  persistPortalState()
}
async function reconcileRazorpayPayment(order, payment) {
  if (payment?.batchId) return reconcilePaymentBatch(payment.batchId, 'Razorpay')
  if (!RAZORPAY_CONFIGURED || !payment?.razorpayOrderId) return { status: payment?.status || 'unknown' }
  const collection = await razorpayRequest(`orders/${encodeURIComponent(payment.razorpayOrderId)}/payments?count=100`)
  const providerPayments = Array.isArray(collection.items) ? collection.items : []
  const validForAmount = providerPayments.filter(item => Number(item.amount) === Math.round(Number(payment.amount || 0) * 100) && item.currency === 'INR')
  let captured = validForAmount.find(item => item.status === 'captured' || item.captured === true)
  if (!captured) {
    const authorized = validForAmount.filter(item => item.status === 'authorized').sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))[0]
    if (authorized?.id) {
      try {
        await razorpayRequest(`payments/${encodeURIComponent(authorized.id)}/capture`, { method: 'POST', body: { amount: authorized.amount, currency: 'INR' } })
      } catch { /* The next fetch decides whether capture already succeeded or still needs review. */ }
      const refreshed = await razorpayRequest(`payments/${encodeURIComponent(authorized.id)}`)
      if (refreshed.status === 'captured' || refreshed.captured === true) captured = refreshed
    }
  }
  if (captured) {
    if (Number(captured.amount) !== Math.round(Number(payment.amount || 0) * 100) || captured.currency !== 'INR') {
      payment.reconciliationError = 'Captured Razorpay amount or currency does not match the portal checkout.'
      persistPortalState()
      return { status: 'mismatch', payment }
    }
    const wasPaid = payment.status === 'Paid' && payment.razorpayPaymentId === captured.id
    let refundSummary = ''
    if (!wasPaid) {
      await finalizeConfirmedPayment(order, payment, { status: 'Paid', reference: captured.id, razorpayPaymentId: captured.id })
      payment.reconcileUntil = ''
      payment.nextReconcileAt = ''
      if (order.status === 'Cancelled') {
        try { await initiateRazorpayRefund(order, payment, { reason: 'Late capture after client cancellation', suffix: 'late-cancel' }); refundSummary = payment.refundStatus === 'pending' ? 'Refund processing' : 'Refund submitted' }
        catch (error) { await markRazorpayRefundFailed(order, payment, error, { notify: true }); refundSummary = 'Refund review required' }
      }
    }
    if (order.status === 'Cancelled' && !refundSummary) refundSummary = payment.refundStatus === 'pending' ? 'Refund processing' : payment.refundStatus === 'processed' ? 'Refund processed' : payment.refundStatus === 'failed' ? 'Refund review required' : 'Refund submitted'
    return { status: 'Paid', payment, refundSummary }
  }
  const failed = validForAmount.filter(item => item.status === 'failed').sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))[0]
  const unresolved = validForAmount.some(item => ['created', 'authorized', 'pending'].includes(item.status))
  if (failed && !unresolved) {
    await markRazorpayPaymentFailed(order, payment, failed, failed.error_description || failed.error_reason || '')
    return { status: 'Failed', payment }
  }
  if (!providerPayments.length && Date.parse(payment.expiresAt || '') <= Date.now() && payment.status !== 'Cancelled') {
    await markRazorpayPaymentFailed(order, payment, null, 'The checkout expired before Razorpay recorded a payment.')
    return { status: 'Failed', payment }
  }
  if (!providerPayments.length && payment.status === 'Cancelled') {
    payment.reconcileUntil ||= new Date(Date.now() + PAYMENT_RECONCILIATION_WINDOW_MS).toISOString()
    payment.nextReconcileAt = new Date(Date.now() + 5 * 60_000).toISOString()
    persistPortalState()
    return { status: 'Cancelled', payment }
  }
  if (unresolved) {
    payment.status = 'Razorpay payment processing'
    payment.reconcileUntil ||= new Date(Date.now() + PAYMENT_RECONCILIATION_WINDOW_MS).toISOString()
    payment.nextReconcileAt = new Date(Date.now() + 5 * 60_000).toISOString()
    persistPortalState()
    return { status: payment.status, payment }
  }
  return { status: payment.status || 'Awaiting Razorpay payment', payment }
}
async function reconcilePendingRazorpayPayments() {
  if (!RAZORPAY_CONFIGURED) return
  const now = Date.now()
  const candidates = orders.flatMap(order => (order.payments || []).filter(payment =>
    payment.provider === 'Razorpay' && payment.razorpayOrderId && (
      (payment.status === 'Awaiting Razorpay payment' && Date.parse(payment.expiresAt || '') <= now) ||
      (['Failed', 'Cancelled', 'Razorpay payment processing'].includes(payment.status) && Date.parse(payment.reconcileUntil || '') > now && Date.parse(payment.nextReconcileAt || '') <= now)
    )
  ).map(payment => ({ order, payment }))).slice(0, 10)
  const reconciledBatches = new Set()
  for (const { order, payment } of candidates) {
    if (payment.batchId && reconciledBatches.has(payment.batchId)) continue
    if (payment.batchId) reconciledBatches.add(payment.batchId)
    try { await reconcileRazorpayPayment(order, payment) }
    catch (error) { payment.reconcileError = String(error.message || 'Razorpay reconciliation is unavailable.').slice(0, 300); payment.nextReconcileAt = new Date(Date.now() + 5 * 60_000).toISOString(); persistPortalState() }
  }
}
async function reconcilePendingRazorpayRefunds() {
  if (!RAZORPAY_CONFIGURED) return
  const candidates = orders.flatMap(order => (order.payments || []).filter(payment =>
    payment.provider === 'Razorpay' && payment.razorpayPaymentId && payment.refundStatus === 'pending' && (!payment.refundNextReconcileAt || Date.parse(payment.refundNextReconcileAt) <= Date.now())
  ).map(payment => ({ order, payment }))).slice(0, 10)
  for (const { order, payment } of candidates) {
    try {
      const collection = await razorpayRequest(`payments/${encodeURIComponent(payment.razorpayPaymentId)}/refunds?count=100`)
      const refunds = Array.isArray(collection.items) ? collection.items : []
      let changed = false
      const previousStatus = payment.refundStatus
      payment.refunds ||= []
      for (const providerRefund of refunds) {
        const localRefund = payment.refunds.find(item => item.id === providerRefund.id || (item.receipt && item.receipt === providerRefund.receipt))
        if (!localRefund) continue
        if (localRefund.status !== providerRefund.status) changed = true
        Object.assign(localRefund, { id: providerRefund.id, receipt: providerRefund.receipt || localRefund.receipt, amount: Number(providerRefund.amount || 0) / 100, status: providerRefund.status || localRefund.status, updatedAt: new Date().toISOString() })
      }
      updateRefundTotals(order, payment)
      payment.refundNextReconcileAt = new Date(Date.now() + 5 * 60_000).toISOString()
      if (changed || previousStatus !== payment.refundStatus) {
        persistPortalState()
        await emailPaymentStateChange(order, 'Refund status updated', [['Payment reference', payment.razorpayPaymentId], ['Refund status', payment.refundStatus], ['Refunded amount', formatINR(payment.amountRefunded)], ['Order balance', formatINR(order.status === 'Cancelled' ? 0 : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0)))]], `Razorpay updated the refund status for order ${order.id}. The current refund details are listed below.`)
      } else persistPortalState()
    } catch (error) {
      payment.refundReconcileError = String(error.message || 'Refund status could not be refreshed.').slice(0, 300)
      payment.refundNextReconcileAt = new Date(Date.now() + 5 * 60_000).toISOString()
      persistPortalState()
    }
  }
}
async function markCashfreePaymentFailed(order, payment, providerPayment, reason = '') {
  const changed = payment.status !== 'Failed'
  payment.status = 'Failed'
  payment.cashfreePaymentId = String(providerPayment?.cf_payment_id || payment.cashfreePaymentId || '')
  payment.failureReason = String(reason || providerPayment?.payment_message || 'Cashfree did not confirm this payment.').slice(0, 300)
  payment.failedAt ||= new Date().toISOString()
  payment.reconcileUntil ||= new Date(Date.now() + PAYMENT_RECONCILIATION_WINDOW_MS).toISOString()
  payment.nextReconcileAt = new Date(Date.now() + 5 * 60_000).toISOString()
  if (changed) await emailPaymentStateChange(order, 'Payment failed', [['Payment provider', 'Cashfree'], ['Payment status', 'Failed'], ['Reason', payment.failureReason], ['Order balance', formatINR(Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0)))]], `Cashfree did not confirm payment for order ${order.id}. The unpaid balance remains due; you can retry from your client portal.`)
  persistPortalState()
}
async function reconcileCashfreePayment(order, payment) {
  if (payment?.batchId) return reconcilePaymentBatch(payment.batchId, 'Cashfree')
  if (!CASHFREE_CONFIGURED || !payment?.cashfreeOrderId) return { status: payment?.status || 'unknown', payment }
  const response = await cashfreeRequest(`orders/${encodeURIComponent(payment.cashfreeOrderId)}/payments`)
  const providerPayments = Array.isArray(response) ? response : Array.isArray(response.payments) ? response.payments : []
  const validPayments = providerPayments.filter(item => Math.abs(Number(item.payment_amount) - Number(payment.amount || 0)) < 0.005 && item.payment_currency === 'INR')
  const successful = validPayments.filter(item => String(item.payment_status || '').toUpperCase() === 'SUCCESS').sort((a, b) => Date.parse(b.payment_time || '') - Date.parse(a.payment_time || ''))[0]
  const mismatchedSuccess = !successful && providerPayments.find(item => String(item.payment_status || '').toUpperCase() === 'SUCCESS')
  if (mismatchedSuccess) {
    payment.status = 'Cashfree payment processing'
    payment.reconciliationError = 'Cashfree reported a successful payment whose amount or currency does not match this checkout. Agency review is required.'
    payment.reconcileUntil ||= new Date(Date.now() + PAYMENT_RECONCILIATION_WINDOW_MS).toISOString()
    payment.nextReconcileAt = new Date(Date.now() + 5 * 60_000).toISOString()
    persistPortalState()
    return { status: 'mismatch', payment }
  }
  if (successful) {
    const paymentId = String(successful.cf_payment_id || '')
    if (!paymentId) return { status: 'mismatch', payment }
    const wasPaid = payment.status === 'Paid' && payment.cashfreePaymentId === paymentId
    let refundSummary = ''
    if (!wasPaid) {
      await finalizeConfirmedPayment(order, payment, { status: 'Paid', reference: successful.bank_reference || paymentId, cashfreePaymentId: paymentId })
      payment.reconcileUntil = ''
      payment.nextReconcileAt = ''
      if (order.status === 'Cancelled') {
        try { await initiateCashfreeRefund(order, payment, { reason: 'Late payment after client cancellation' }); refundSummary = payment.refundStatus === 'pending' ? 'Refund processing' : 'Refund submitted' }
        catch (error) { await markRazorpayRefundFailed(order, payment, error, { notify: true }); refundSummary = 'Refund review required' }
      }
    } else if (order.status === 'Cancelled' && payment.refundStatus !== 'processed' && payment.refundStatus !== 'pending') {
      try { await initiateCashfreeRefund(order, payment, { reason: 'Late payment after client cancellation' }) }
      catch (error) { await markRazorpayRefundFailed(order, payment, error, { notify: true }) }
    }
    if (order.status === 'Cancelled' && !refundSummary) refundSummary = payment.refundStatus === 'pending' ? 'Refund processing' : payment.refundStatus === 'processed' ? 'Refund processed' : payment.refundStatus === 'failed' ? 'Refund review required' : 'Refund submitted'
    return { status: 'Paid', payment, refundSummary }
  }
  const hasPaymentAttempt = providerPayments.length > 0
  const unresolved = validPayments.some(item => ['PENDING', 'NOT_ATTEMPTED'].includes(String(item.payment_status || '').toUpperCase()))
  const failed = validPayments.filter(item => ['FAILED', 'USER_DROPPED', 'CANCELLED'].includes(String(item.payment_status || '').toUpperCase())).sort((a, b) => Date.parse(b.payment_time || '') - Date.parse(a.payment_time || ''))[0]
  if (failed && !unresolved) {
    await markCashfreePaymentFailed(order, payment, failed, failed.payment_message || '')
    return { status: 'Failed', payment }
  }
  if (!hasPaymentAttempt && Date.parse(payment.expiresAt || '') <= Date.now() && payment.status !== 'Cancelled') {
    await markCashfreePaymentFailed(order, payment, null, 'The checkout expired before Cashfree recorded a payment.')
    return { status: 'Failed', payment }
  }
  if (!hasPaymentAttempt && payment.status === 'Cancelled') {
    payment.reconcileUntil ||= new Date(Date.now() + PAYMENT_RECONCILIATION_WINDOW_MS).toISOString()
    payment.nextReconcileAt = new Date(Date.now() + 5 * 60_000).toISOString()
    persistPortalState()
    return { status: 'Cancelled', payment }
  }
  if (unresolved || (hasPaymentAttempt && !failed && !successful)) {
    payment.status = 'Cashfree payment processing'
    payment.reconcileUntil ||= new Date(Date.now() + PAYMENT_RECONCILIATION_WINDOW_MS).toISOString()
    payment.nextReconcileAt = new Date(Date.now() + 5 * 60_000).toISOString()
    persistPortalState()
    return { status: payment.status, payment }
  }
  return { status: payment.status || 'Awaiting Cashfree payment', payment }
}
const paymentBatchReconciliationsInProgress = new Set()
function getPaymentBatchEntries(batchId) {
  return orders.flatMap(order => (order.payments || [])
    .filter(payment => payment.batchId === batchId)
    .map(payment => ({ order, payment })))
}
function setPaymentBatchState(entries, status, providerName, reason = '') {
  for (const { payment } of entries) {
    payment.status = status
    payment.reconcileUntil ||= new Date(Date.now() + PAYMENT_RECONCILIATION_WINDOW_MS).toISOString()
    payment.nextReconcileAt = new Date(Date.now() + 5 * 60_000).toISOString()
    if (reason) payment.reconciliationError = reason
    else delete payment.reconciliationError
  }
  persistPortalState()
  return { status, provider: providerName, allocations: entries.map(entry => ({ orderId: entry.order.id, payment: entry.payment })) }
}
async function reconcilePaymentBatch(batchId, providerName) {
  const entries = getPaymentBatchEntries(batchId)
  if (!entries.length) return { status: 'not_found', allocations: [] }
  const paymentProvider = entries[0].payment.provider
  if (entries.some(entry => entry.payment.provider !== paymentProvider) || (providerName && paymentProvider !== providerName)) return { status: 'mismatch', allocations: entries.map(entry => ({ orderId: entry.order.id, payment: entry.payment })) }
  const configured = paymentProvider === 'Cashfree' ? CASHFREE_CONFIGURED : RAZORPAY_CONFIGURED
  if (!configured) return { status: 'unavailable', allocations: entries.map(entry => ({ orderId: entry.order.id, payment: entry.payment })) }
  const lockKey = `${paymentProvider}:${batchId}`
  if (paymentBatchReconciliationsInProgress.has(lockKey)) return { status: 'processing', allocations: entries.map(entry => ({ orderId: entry.order.id, payment: entry.payment })) }
  paymentBatchReconciliationsInProgress.add(lockKey)
  try {
    const firstPayment = entries[0].payment
    const expectedAmount = Math.round(Number(firstPayment.batchTotalAmount || entries.reduce((sum, entry) => sum + Number(entry.payment.amount || 0), 0)) * 100)
    if (!Number.isFinite(expectedAmount) || expectedAmount <= 0 || entries.some(entry => Math.round(Number(entry.payment.batchTotalAmount || 0) * 100) !== expectedAmount)) {
      return setPaymentBatchState(entries, paymentProvider === 'Cashfree' ? 'Cashfree payment processing' : 'Razorpay payment processing', paymentProvider, 'The saved multi-order payment allocation does not match the checkout total. Agency review is required.')
    }
    let providerPayments = []
    let successful = null
    let failed = null
    let unresolved = false
    if (paymentProvider === 'Razorpay') {
      if (!firstPayment.razorpayOrderId) return { status: 'mismatch', allocations: entries.map(entry => ({ orderId: entry.order.id, payment: entry.payment })) }
      const collection = await razorpayRequest(`orders/${encodeURIComponent(firstPayment.razorpayOrderId)}/payments?count=100`)
      providerPayments = Array.isArray(collection.items) ? collection.items : []
      const matched = providerPayments.filter(item => Number(item.amount) === expectedAmount && item.currency === 'INR')
      successful = matched.find(item => item.status === 'captured' || item.captured === true)
      if (!successful) {
        const authorized = matched.filter(item => item.status === 'authorized').sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))[0]
        if (authorized?.id) {
          try { await razorpayRequest(`payments/${encodeURIComponent(authorized.id)}/capture`, { method: 'POST', body: { amount: authorized.amount, currency: 'INR' } }) } catch { /* Provider status below is authoritative. */ }
          const refreshed = await razorpayRequest(`payments/${encodeURIComponent(authorized.id)}`)
          if (refreshed.status === 'captured' || refreshed.captured === true) successful = refreshed
        }
      }
      if (!successful && providerPayments.some(item => item.status === 'captured' || item.captured === true)) {
        return setPaymentBatchState(entries, 'Razorpay payment processing', paymentProvider, 'Razorpay reported a capture whose amount or currency does not match the selected orders.')
      }
      unresolved = matched.some(item => ['created', 'authorized', 'pending'].includes(item.status))
      failed = matched.filter(item => item.status === 'failed').sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))[0]
    } else {
      if (!firstPayment.cashfreeOrderId) return { status: 'mismatch', allocations: entries.map(entry => ({ orderId: entry.order.id, payment: entry.payment })) }
      const collection = await cashfreeRequest(`orders/${encodeURIComponent(firstPayment.cashfreeOrderId)}/payments`)
      providerPayments = Array.isArray(collection) ? collection : Array.isArray(collection.payments) ? collection.payments : []
      const matched = providerPayments.filter(item => Math.abs(Number(item.payment_amount) - expectedAmount / 100) < 0.005 && item.payment_currency === 'INR')
      successful = matched.filter(item => String(item.payment_status || '').toUpperCase() === 'SUCCESS').sort((a, b) => Date.parse(b.payment_time || '') - Date.parse(a.payment_time || ''))[0]
      if (!successful && providerPayments.some(item => String(item.payment_status || '').toUpperCase() === 'SUCCESS')) {
        return setPaymentBatchState(entries, 'Cashfree payment processing', paymentProvider, 'Cashfree reported a successful payment whose amount or currency does not match the selected orders.')
      }
      unresolved = matched.some(item => ['PENDING', 'NOT_ATTEMPTED'].includes(String(item.payment_status || '').toUpperCase()))
      failed = matched.filter(item => ['FAILED', 'USER_DROPPED', 'CANCELLED'].includes(String(item.payment_status || '').toUpperCase())).sort((a, b) => Date.parse(b.payment_time || '') - Date.parse(a.payment_time || ''))[0]
    }
    if (successful) {
      const providerPaymentId = paymentProvider === 'Cashfree' ? String(successful.cf_payment_id || '') : String(successful.id || '')
      const exactAmount = paymentProvider === 'Cashfree' ? Math.abs(Number(successful.payment_amount) * 100 - expectedAmount) < 0.5 && successful.payment_currency === 'INR' : Number(successful.amount) === expectedAmount && successful.currency === 'INR'
      if (!providerPaymentId || !exactAmount) return setPaymentBatchState(entries, `${paymentProvider} payment processing`, paymentProvider, 'The confirmed payment ID, amount, or currency could not be verified.')
      for (const { order, payment } of entries) {
        const alreadyPaid = payment.status === 'Paid' && payment.batchFinalizedAt && (paymentProvider === 'Cashfree' ? payment.cashfreePaymentId === providerPaymentId : payment.razorpayPaymentId === providerPaymentId)
        if (!alreadyPaid) {
          await finalizeConfirmedPayment(order, payment, {
            status: 'Paid',
            reference: paymentProvider === 'Cashfree' ? successful.bank_reference || providerPaymentId : providerPaymentId,
            razorpayPaymentId: paymentProvider === 'Razorpay' ? providerPaymentId : '',
            cashfreePaymentId: paymentProvider === 'Cashfree' ? providerPaymentId : ''
          })
          payment.batchFinalizedAt = new Date().toISOString()
        }
        payment.reconcileUntil = ''
        payment.nextReconcileAt = ''
        if (order.status === 'Cancelled' && payment.refundStatus !== 'processed' && payment.refundStatus !== 'pending') {
          try { await initiateOnlineRefund(order, payment, { reason: 'Late payment after client cancellation', suffix: 'late-cancel' }) }
          catch (error) { await markRazorpayRefundFailed(order, payment, error, { notify: true }) }
        }
      }
      persistPortalState()
      return { status: 'Paid', provider: paymentProvider, allocations: entries.map(entry => ({ orderId: entry.order.id, payment: entry.payment, refundSummary: entry.order.status === 'Cancelled' ? entry.payment.refundStatus || 'Refund submitted' : '' })) }
    }
    if (failed && !unresolved) {
      for (const { order, payment } of entries) {
        if (paymentProvider === 'Cashfree') await markCashfreePaymentFailed(order, payment, failed, failed.payment_message || '')
        else await markRazorpayPaymentFailed(order, payment, failed, failed.error_description || failed.error_reason || '')
      }
      return { status: 'Failed', provider: paymentProvider, allocations: entries.map(entry => ({ orderId: entry.order.id, payment: entry.payment })) }
    }
    const expired = !providerPayments.length && Date.parse(firstPayment.expiresAt || '') <= Date.now()
    if (expired) {
      for (const { order, payment } of entries) {
        if (paymentProvider === 'Cashfree') await markCashfreePaymentFailed(order, payment, null, 'The checkout expired before Cashfree recorded a payment.')
        else await markRazorpayPaymentFailed(order, payment, null, 'The checkout expired before Razorpay recorded a payment.')
      }
      return { status: 'Failed', provider: paymentProvider, allocations: entries.map(entry => ({ orderId: entry.order.id, payment: entry.payment })) }
    }
    if (unresolved || (providerPayments.length && !failed)) {
      return setPaymentBatchState(entries, paymentProvider === 'Cashfree' ? 'Cashfree payment processing' : 'Razorpay payment processing', paymentProvider)
    }
    return { status: firstPayment.status || `Awaiting ${paymentProvider} payment`, provider: paymentProvider, allocations: entries.map(entry => ({ orderId: entry.order.id, payment: entry.payment })) }
  } finally {
    paymentBatchReconciliationsInProgress.delete(lockKey)
  }
}
async function reconcilePendingCashfreePayments() {
  if (!CASHFREE_CONFIGURED) return
  const now = Date.now()
  const candidates = orders.flatMap(order => (order.payments || []).filter(payment =>
    payment.provider === 'Cashfree' && payment.cashfreeOrderId && (
      (payment.status === 'Awaiting Cashfree payment' && Date.parse(payment.expiresAt || '') <= now) ||
      (['Failed', 'Cancelled', 'Cashfree payment processing'].includes(payment.status) && Date.parse(payment.reconcileUntil || '') > now && Date.parse(payment.nextReconcileAt || '') <= now)
    )
  ).map(payment => ({ order, payment }))).slice(0, 10)
  const reconciledBatches = new Set()
  for (const { order, payment } of candidates) {
    if (payment.batchId && reconciledBatches.has(payment.batchId)) continue
    if (payment.batchId) reconciledBatches.add(payment.batchId)
    try { await reconcileCashfreePayment(order, payment) }
    catch (error) { payment.reconcileError = String(error.message || 'Cashfree reconciliation is unavailable.').slice(0, 300); payment.nextReconcileAt = new Date(Date.now() + 5 * 60_000).toISOString(); persistPortalState() }
  }
}
async function reconcilePendingCashfreeRefunds() {
  if (!CASHFREE_CONFIGURED) return
  const candidates = orders.flatMap(order => (order.payments || []).filter(payment =>
    payment.provider === 'Cashfree' && payment.cashfreeOrderId && (payment.refunds || []).some(refund => ['pending', 'initiating'].includes(refund.status) && (!refund.nextReconcileAt || Date.parse(refund.nextReconcileAt) <= Date.now()))
  ).map(payment => ({ order, payment }))).slice(0, 10)
  for (const { order, payment } of candidates) {
    try {
      let changed = false
      const previousStatus = payment.refundStatus
      for (const refund of payment.refunds || []) {
        if (!refund.id || !['pending', 'initiating'].includes(refund.status)) continue
        const providerRefund = await cashfreeRequest(`orders/${encodeURIComponent(payment.cashfreeOrderId)}/refunds/${encodeURIComponent(refund.id)}`)
        const previous = refund.status
        updateCashfreeRefundRecord(payment, providerRefund, refund)
        if (previous !== refund.status) changed = true
        refund.nextReconcileAt = new Date(Date.now() + 5 * 60_000).toISOString()
      }
      updateRefundTotals(order, payment)
      if (changed || previousStatus !== payment.refundStatus) {
        persistPortalState()
        await emailPaymentStateChange(order, 'Refund status updated', [['Payment provider', 'Cashfree'], ['Payment reference', payment.cashfreePaymentId], ['Refund status', payment.refundStatus], ['Refunded amount', formatINR(payment.amountRefunded)], ['Order balance', formatINR(order.status === 'Cancelled' ? 0 : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0)))]], `Cashfree updated the refund status for order ${order.id}. The current refund details are listed below.`)
      } else persistPortalState()
    } catch (error) {
      payment.refundReconcileError = String(error.message || 'Cashfree refund status could not be refreshed.').slice(0, 300)
      for (const refund of payment.refunds || []) if (['pending', 'initiating'].includes(refund.status)) refund.nextReconcileAt = new Date(Date.now() + 5 * 60_000).toISOString()
      persistPortalState()
    }
  }
}
async function reconcileOnlinePayment(order, payment) {
  return payment.provider === 'Cashfree' ? reconcileCashfreePayment(order, payment) : reconcileRazorpayPayment(order, payment)
}
function validStatementDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
async function queueStatementEmail(profile, accountOrders, fromDate, toDate) {
  if (!profile.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
    throw new Error('This profile does not have a valid registered email address.')
  }
  const generatedAt = new Date()
  const pdf = createStatementPdf({ profile, orders: accountOrders, fromDate, toDate, generatedAt })
  const attachment = {
    name: `${safeFileName(profile.shopName || 'Client')}-statement-${fromDate}-to-${toDate}.pdf`,
    data: await blobDataUrl(pdf)
  }
  const totalDue = accountOrders.reduce((sum, order) => sum + (order.status === 'Cancelled' ? 0 : Number(order.amountDue || 0)), 0)
  const totalPaid = accountOrders.reduce((sum, order) => sum + Number(order.amountPaid || 0), 0)
  const outstanding = accountOrders.reduce((sum, order) => sum + (order.status === 'Cancelled' ? 0 : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0))), 0)
  return enqueueTransactionalEmail({
    idempotencyKey: `statement/${profile.id}/${randomUUID()}`,
    to: profile.email,
    subject: `Gouri Agency | Account statement for ${profile.shopName || profile.gstNumber}`,
    html: professionalEmail({
      title: 'Client account statement',
      greeting: profile.ownerName || profile.shopName,
      introduction: `The requested account statement for ${profile.shopName || 'your customer account'} is attached as a PDF. The statement includes order and payment activity for the selected date range.`,
      sections: [{ title: 'Statement details', fields: [
        ['Shop / pharmacy', profile.shopName || 'Customer account'],
        ['GST number', profile.gstNumber || 'Not provided'],
        ['Drug license number', profile.drugLicenseNumber || 'Not provided'],
        ['Drug license expiry date', profile.drugLicenseExpiresAt || 'Not recorded'],
        ['Statement period', `${fromDate} to ${toDate}`],
        ['Generated date and time', emailTimestamp(generatedAt)],
        ['Current total dues', formatINR(totalDue)],
        ['Current total paid', formatINR(totalPaid)],
        ['Current outstanding balance', formatINR(outstanding)]
      ] }],
      attachmentNote: 'The requested statement PDF is attached. It includes its date range, order and payment timestamps, and digital-document notice.'
    }),
    attachments: [pdfEmailAttachment(attachment)], profileId: profile.id
  })
}
function queueExpiredDrugLicenseEmail({ email, customerName, shopName, gstNumber, expiryDate }) {
  const expiryKey = validDateKey(expiryDate) ? expiryDate : 'not-recorded'
  return enqueueTransactionalEmail({
    idempotencyKey: `expired-drug-license/${normalizeGst(gstNumber)}/${expiryKey}`,
    to: email,
    subject: 'Gouri Agency | Order request not accepted - expired drug license',
    emailType: 'expired_drug_license',
    html: professionalEmail({
      title: 'Order request not accepted',
      greeting: customerName || shopName || 'Customer',
      introduction: `We could not accept the order request for ${shopName || 'your pharmacy'} because the drug license is expired${validDateKey(expiryDate) ? ` as of ${expiryDate}` : ''}. No order was created from this request.`,
      sections: [{ title: 'Required next step', fields: [
        ['Shop / pharmacy', shopName || 'Not provided'],
        ['Drug license number', 'Please provide a current license number'],
        ['Expiry date on this request', validDateKey(expiryDate) ? expiryDate : 'Not provided']
      ] }],
      attachmentNote: 'Please provide a current drug license copy and contact Gouri Agency so an admin can update the expiry date on your customer profile. You may submit a new order request after the profile is updated.'
    }),
    attachments: []
  })
}
function queueDueReminderEmail(profile, dueOrders, intervalDays, now) {
  const outstanding = dueOrders.reduce((sum, order) => sum + Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0)), 0)
  const orderFields = dueOrders.map(order => {
    const balance = Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0))
    return [`Order ${order.id}`, `${formatINR(balance)} outstanding · placed ${emailTimestamp(order.date)}`]
  })
  const cycle = Math.floor(now.getTime() / 60000)
  return enqueueTransactionalEmail({
    idempotencyKey: `due-reminder/${profile.id}/${cycle}`,
    profileId: profile.id,
    emailType: 'due_reminder',
    to: profile.email,
    subject: `Gouri Agency | Outstanding balance reminder for ${profile.shopName || profile.gstNumber}`,
    html: professionalEmail({
      title: 'Outstanding balance reminder',
      greeting: profile.ownerName || profile.shopName,
      introduction: 'Our records show an unpaid balance on your Gouri Agency account. Please review the order balances below and arrange payment. If you have already transferred payment, contact us so the receipt can be confirmed and recorded.',
      sections: [
        { title: 'Account summary', fields: [
          ['Shop / pharmacy', profile.shopName || 'Customer account'],
          ['GST number', profile.gstNumber || 'Not provided'],
          ['Outstanding balance', formatINR(outstanding)],
          ['Reminder frequency', `Every ${intervalDays} day${intervalDays === 1 ? '' : 's'}`],
          ['Reminder date and time', emailTimestamp(now)]
        ] },
        { title: 'Orders with outstanding balances', fields: orderFields }
      ],
      attachmentNote: 'This is an automatic payment reminder. Reminders stop automatically when your outstanding balance is cleared. You can review your order balances and payment options in the client portal.'
    }),
    attachments: []
  })
}
let dueReminderSchedulerRunning = false
async function processDueReminderSchedule() {
  if (dueReminderSchedulerRunning || !paymentSettings.dueReminders.enabled) return
  dueReminderSchedulerRunning = true
  try {
    await refreshPortalStateFromAtlas()
    if (!paymentSettings.dueReminders.enabled) return
    const now = Date.now()
    const intervalMs = paymentSettings.dueReminders.intervalDays * DAY_MS
    for (const profile of profilesByGst.values()) {
      if (!profile.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) continue
      const dueOrders = orders.filter(order => order.profileId === profile.id && order.status !== 'Cancelled' && Number(order.amountDue || 0) - Number(order.amountPaid || 0) > 0.005)
      if (!dueOrders.length) continue
      const dueSince = dueOrders.map(order => Date.parse(order.amountDueUpdatedAt || order.updatedAt || order.date || ''))
        .filter(Number.isFinite)
        .reduce((earliest, value) => Math.min(earliest, value), Infinity)
      const lastReminderAt = emailOutbox
        .filter(job => job.emailType === 'due_reminder' && job.profileId === profile.id)
        .map(job => Date.parse(job.createdAt || ''))
        .filter(Number.isFinite)
        .reduce((latest, value) => Math.max(latest, value), 0)
      const anchor = Math.max(Number.isFinite(dueSince) ? dueSince : now, lastReminderAt)
      if (now - anchor < intervalMs) continue
      queueDueReminderEmail(profile, dueOrders, paymentSettings.dueReminders.intervalDays, new Date(now))
    }
    await persistenceTail
  } finally {
    dueReminderSchedulerRunning = false
  }
}
function profileChangedFields(before, after, submittedAttachments = {}) {
  const labels = [
    ['shopName', 'Shop / pharmacy name'], ['businessType', 'Business type'], ['ownerName', 'Owner name'],
    ['partnerOne', 'Partner 1'], ['partnerTwo', 'Partner 2'], ['email', 'Registered email'], ['mobile', 'Mobile number'],
    ['shopAddress', 'Shop address'], ['pincode', 'PIN code'], ['city', 'City / district'], ['state', 'State'], ['country', 'Country'],
    ['gstNumber', 'GST number'], ['drugLicenseNumber', 'Drug license number'],
    ['drugLicenseExpiresAt', 'Drug license expiry date']
  ]
  const fields = labels.filter(([key]) => String(before[key] || '') !== String(after[key] || '')).map(([key, label]) => [label, after[key] || 'Not applicable'])
  const documentLabels = { ownerPhoto: 'Owner photo', drugLicense: 'Drug license', gstCopy: 'GST copy', signature: 'Authorized signature' }
  for (const [key, label] of Object.entries(documentLabels)) {
    const uploaded = submittedAttachments[key]
    if (uploaded && uploaded.name !== before.attachments?.[key]?.name) fields.push([`${label} document`, uploaded.name])
  }
  return fields
}
function migrateQueuedEmailSerials() {
  let changed = false
  for (const job of emailOutbox) {
    if (job.status === 'sent') continue
    if (!/^\d{15}$/.test(job.serial || '')) {
      job.serial = reserveEmailSerial()
      job.subject = `${String(job.subject || 'Gouri Agency account notification').replace(/\s*\|\s*SR No\.\s*\d{15}$/i, '')} | SR No. ${job.serial}`
      const originalMessage = String(job.html || '')
        .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/p\s*>/gi, '\n')
        .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim()
      job.html = professionalEmail({
        title: 'Account notification', greeting: 'Customer',
        introduction: 'A previously queued Gouri Agency account email is being delivered.',
        sections: [{ title: 'Previous notification', fields: [['Message', originalMessage || 'Please see the attached document.']] }],
        attachmentNote: 'Previously queued PDF documents remain attached to this email.'
      }).replaceAll('{{EMAIL_SERIAL}}', job.serial)
      changed = true
    } else if (!String(job.subject || '').includes(job.serial)) {
      job.subject = `${job.subject || 'Gouri Agency account notification'} | SR No. ${job.serial}`
      changed = true
    }
    const relatedOrder = job.orderId ? orders.find(order => order.id === job.orderId) : null
    const profiles = [...profilesByGst.values()]
    const relatedProfile = profiles.find(profile => profile.id === job.profileId)
      || profiles.find(profile => profile.id === relatedOrder?.profileId)
      || profiles.find(profile => String(profile.email || '').toLowerCase() === String(job.to || '').toLowerCase())
    const greeting = relatedProfile?.ownerName || relatedProfile?.shopName || relatedOrder?.ownerName || relatedOrder?.shopName || ''
    const standardizedHtml = standardizeQueuedEmail(job.html, greeting)
    if (standardizedHtml !== job.html) { job.html = standardizedHtml; changed = true }
  }
  if (changed) persistPortalState()
}
migrateQueuedEmailSerials()
function formatINR(value) { return `INR ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
async function finalizeConfirmedPayment(order, payment, { status, reference, razorpayPaymentId = '', cashfreePaymentId = '' }) {
  const previouslyPaid = Number(order.amountPaid || 0)
  if (!Number.isFinite(Number(order.paidBalanceAdjustment))) {
    const previouslyRecordedPayments = (order.payments || []).filter(row => ['Paid', 'Verified'].includes(row.status))
      .reduce((sum, row) => sum + confirmedOrderPaymentAmount(row, order.id), 0)
    order.paidBalanceAdjustment = Math.max(0, previouslyPaid - previouslyRecordedPayments)
  }
  payment.status = status
  payment.reference = reference || payment.reference || ''
  if (razorpayPaymentId) payment.razorpayPaymentId = razorpayPaymentId
  if (cashfreePaymentId) payment.cashfreePaymentId = cashfreePaymentId
  payment.paidAt ||= new Date().toISOString()
  payment.dueAtPayment = Number(order.amountDue || 0)
  applyConfirmedPaymentAllocation(order, payment)
  recomputeOrderPaidAmount(order)
  payment.totalPaidAfter = order.amountPaid
  payment.balanceAfterPayment = Math.max(0, Number(payment.dueAtPayment || 0) - order.amountPaid)
  const latestPaidAt = (order.payments || [])
    .filter(row => ['Paid', 'Verified'].includes(row.status))
    .map(row => row.paidAt || row.reviewedAt || row.submittedAt)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0]
  if (latestPaidAt) order.lastPaymentAt = latestPaidAt
  if (Number(order.amountDue || 0) > 0 && previouslyPaid < Number(order.amountDue) && order.amountPaid >= Number(order.amountDue) - 0.005) {
    order.fullyPaidAt = payment.paidAt
    order.paymentEditLockedUntil = new Date(Date.parse(payment.paidAt) + DAY_MS).toISOString()
  }
  const profile = [...profilesByGst.values()].find(item => item.id === order.profileId)
  const ledger = profile ? await refreshLatestLedger(profile, order) : null
  const receipt = profile ? await createSavedPaymentReceipt(profile, order, payment) : null
  persistPortalState()
  if (profile && ledger && receipt) {
    const job = queuePaymentConfirmationEmail(profile, order, payment, ledger, receipt)
    payment.emailStatus = job.status
    persistPortalState()
  }
  return { order, payment, profile, ledger, receipt, affectedOrders: orders.filter(item => item.profileId === order.profileId) }
}
async function sendPaymentReceipt(res, order, payment) {
  if (!['Paid', 'Verified'].includes(payment.status)) return json(res, 409, { error: 'A receipt is available after the payment is captured or verified.' })
  const profile = [...profilesByGst.values()].find(item => item.id === order.profileId)
  if (!profile) return json(res, 404, { error: 'Customer profile not found.' })
  const receipt = await createSavedPaymentReceipt(profile, order, payment)
  return sendPdf(res, receipt, receipt.name)
}
function findProfileByIdentifier(identifier) {
  const value = String(identifier || '').trim()
  const email = value.toLowerCase()
  const phone = normalizePhone(value)
  const gst = normalizeGst(value)
  return [...profilesByGst.values()].find(profile =>
    profile.email?.trim().toLowerCase() === email ||
    (phone.length >= 10 && normalizePhone(profile.mobile) === phone) ||
    (gst && normalizeGst(profile.gstNumber) === gst)
  ) || null
}
function validateProfileFields(data) {
  const requiredFields = ['email', 'mobile', 'shopName', 'shopAddress', 'gstNumber', 'drugLicenseNumber']
  if (requiredFields.some(field => typeof data[field] !== 'string' || !data[field].trim())) {
    return 'Complete the email, mobile, and shop details.'
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) return 'Enter a valid email address.'
  if (!/^\+?[0-9\s()-]+$/.test(data.mobile.trim()) || !/^\d{10,15}$/.test(data.mobile.replace(/\D/g, ''))) {
    return 'Enter a valid mobile number with 10 to 15 digits.'
  }
  if (data.pincode && !/^\d{6}$/.test(String(data.pincode).trim())) return 'Enter a valid six-digit PIN code.'
  if (['city', 'state', 'country'].some(field => String(data[field] || '').length > 100)) return 'City, state, and country must each be 100 characters or fewer.'
  if (!['Sole proprietorship', 'Partnership'].includes(data.businessType)) return 'Choose a valid business type.'
  if (data.businessType === 'Sole proprietorship' && (typeof data.ownerName !== 'string' || !data.ownerName.trim())) return 'Enter the shop owner name.'
  if (data.businessType === 'Partnership' && (
    typeof data.partnerOne !== 'string' || !data.partnerOne.trim() ||
    typeof data.partnerTwo !== 'string' || !data.partnerTwo.trim()
  )) return 'Enter the names of both partners.'
  return ''
}
function updateProfile(profile, data, { allowProtectedFields = false, allowDrugLicense = false, allowExpiryDate = false } = {}) {
  const canUpdateDrugLicense = allowProtectedFields || allowDrugLicense
  const canUpdateExpiryDate = allowProtectedFields || allowExpiryDate
  const fields = { ...profile, ...data }
  const error = validateProfileFields(fields)
  if (error) return { error }
  if (canUpdateExpiryDate && !validDateKey(fields.drugLicenseExpiresAt)) return { error: 'Enter a valid drug license expiry date.' }
  const nextGst = normalizeGst(fields.gstNumber)
  if (allowProtectedFields) {
    const duplicate = profilesByGst.get(nextGst)
    if (duplicate && duplicate.id !== profile.id) return { error: 'Another customer profile already uses this GST number.', status: 409 }
  }
  const suppliedAttachments = data.attachments || {}
  if (suppliedAttachments.ownerPhoto && !validUpload(suppliedAttachments.ownerPhoto, ['image/jpeg', 'image/png'])) return { error: 'Upload a valid profile photo JPG or PNG (up to 5 MB).' }
  if (canUpdateDrugLicense && suppliedAttachments.drugLicense && !validUpload(suppliedAttachments.drugLicense, ['application/pdf', 'image/jpeg'])) return { error: 'Upload a valid drug license PDF or JPG (up to 5 MB).' }
  if (allowProtectedFields && suppliedAttachments.gstCopy && !validUpload(suppliedAttachments.gstCopy, ['application/pdf', 'image/jpeg'])) return { error: 'Upload a valid GST copy PDF or JPG (up to 5 MB).' }
  if (allowProtectedFields && suppliedAttachments.signature && !validUpload(suppliedAttachments.signature, ['image/png'])) return { error: 'Upload a valid extracted signature PNG (up to 5 MB).' }
  const oldGst = normalizeGst(profile.gstNumber)
  Object.assign(profile, {
    shopName: fields.shopName.trim(),
    businessType: fields.businessType,
    ownerName: fields.businessType === 'Sole proprietorship' ? fields.ownerName.trim() : '',
    partnerOne: fields.businessType === 'Partnership' ? fields.partnerOne.trim() : '',
    partnerTwo: fields.businessType === 'Partnership' ? fields.partnerTwo.trim() : '',
    email: fields.email.trim(),
    mobile: fields.mobile.trim(),
    shopAddress: fields.shopAddress.trim(),
    pincode: String(fields.pincode || '').trim(),
    city: String(fields.city || '').trim(),
    state: String(fields.state || '').trim(),
    country: String(fields.country || '').trim(),
    gstNumber: allowProtectedFields ? nextGst : profile.gstNumber,
    gstVerifiedAt: allowProtectedFields && oldGst !== nextGst ? null : (profile.gstVerifiedAt || null),
    drugLicenseNumber: canUpdateDrugLicense ? fields.drugLicenseNumber.trim() : profile.drugLicenseNumber,
    drugLicenseExpiresAt: canUpdateExpiryDate ? fields.drugLicenseExpiresAt : profile.drugLicenseExpiresAt,
    updatedAt: new Date().toISOString(),
    attachments: {
      ...profile.attachments,
      ownerPhoto: suppliedAttachments.ownerPhoto || profile.attachments?.ownerPhoto || null,
      drugLicense: canUpdateDrugLicense ? (suppliedAttachments.drugLicense || profile.attachments?.drugLicense || null) : profile.attachments?.drugLicense || null,
      gstCopy: allowProtectedFields ? (suppliedAttachments.gstCopy || profile.attachments?.gstCopy || null) : profile.attachments?.gstCopy || null,
      signature: allowProtectedFields ? (suppliedAttachments.signature || profile.attachments?.signature || null) : profile.attachments?.signature || null
    }
  })
  if (allowProtectedFields && oldGst !== nextGst) {
    profilesByGst.delete(oldGst)
    profilesByGst.set(nextGst, profile)
  }
  return { profile }
}
const json = async (res, status, data) => {
  try { await persistenceTail }
  catch {
    status = 503
    data = { error: 'MongoDB Atlas could not confirm the latest portal data. Please retry.' }
  }
  if (res.destroyed || res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}
function homeSliderPayload() {
  return {
    enabled: homeSlider.enabled,
    intervalSeconds: homeSlider.intervalSeconds,
    images: homeSlider.images.map((image, index) => image ? {
      ...image,
      url: image.type === 'image/svg+xml'
        ? `/home-slider/default-${index + 1}.svg`
        : `/api/home-slider/images/${image.id}.${image.type === 'image/jpeg' ? 'jpg' : 'png'}`
    } : null)
  }
}
async function migrateLegacyHomeSliderAssets() {
  for (const image of homeSlider.images.filter(Boolean)) {
    if (image.type === 'image/svg+xml') continue
    const existing = await mongoDb.collection('home_slider_assets.files').findOne({ 'metadata.assetId': image.id })
    if (existing) continue
    const extension = image.type === 'image/jpeg' ? 'jpg' : 'png'
    try {
      const bytes = readFileSync(new URL(`${image.id}.${extension}`, homeSliderDirectory))
      await uploadGridFsBuffer(homeSliderAssetBucket, `home-slide-${image.id}`, bytes, { kind: 'home-slider', assetId: image.id, name: image.name }, image.type)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}
function sendPdf(res, document, fallbackName = 'document.pdf') {
  if (!document?.data?.startsWith('data:application/pdf;base64,')) return json(res, 404, { error: 'PDF document is not available.' })
  const name = safeFileName(document.name || fallbackName)
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store'
  })
  res.end(Buffer.from(document.data.slice(document.data.indexOf(',') + 1), 'base64'))
}
async function readRawBody(req, maxBytes = MAX_REQUEST_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) { req.resume(); return null }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
async function readJson(req, res) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) {
      json(res, 413, { error: 'Request is too large. Upload files up to 5 MB each.' })
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      json(res, 400, { error: 'Request body must be a JSON object.' })
      return null
    }
    return body
  } catch {
    json(res, 400, { error: 'Invalid JSON request.' })
    return null
  }
}
function validUpload(upload, allowedTypes) {
  if (!upload || typeof upload.name !== 'string' || typeof upload.data !== 'string') return false
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(upload.data)
  if (!match || !allowedTypes.includes(match[1]) || upload.type !== match[1]) return false
  const extension = upload.name.split('.').pop().toLowerCase()
  const typeByExtension = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' }
  if (typeByExtension[extension] !== match[1]) return false
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) return false
  if (match[1] === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-'
  if (match[1] === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const holidayCalendarMatch = /^\/api\/holidays\/(\d{4})\/([A-Z]{2})$/i.exec(url.pathname)
  if (req.method === 'GET' && url.pathname === '/api/public-stats') {
    try {
      const stats = await publicSiteStatsCollection.findOne({ _id: 'homepage' }, { projection: { visitorCount: 1 } })
      return json(res, 200, { visitorCount: Number(stats?.visitorCount || 0) })
    } catch (error) {
      return json(res, 503, { error: 'Visitor count is temporarily unavailable.' })
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/public-stats/visit') {
    try {
      await publicSiteStatsCollection.updateOne({ _id: 'homepage' }, { $inc: { visitorCount: 1 }, $setOnInsert: { createdAt: new Date() } }, { upsert: true })
      const stats = await publicSiteStatsCollection.findOne({ _id: 'homepage' }, { projection: { visitorCount: 1 } })
      return json(res, 200, { visitorCount: Number(stats?.visitorCount || 0) })
    } catch (error) {
      return json(res, 503, { error: 'Visitor count could not be updated right now.' })
    }
  }
  const doesNotNeedPortalRefresh = ['/api/login', '/api/health', '/api/gst/verify'].includes(url.pathname) || /^\/api\/(?:pincode\/\d{6}|ifsc\/[A-Z]{4}0[A-Z0-9]{6}|holidays\/\d{4}\/[A-Z]{2})$/i.test(url.pathname)
  if (url.pathname.startsWith('/api/') && !doesNotNeedPortalRefresh) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      refreshPortalStateFromAtlas().catch(error => console.warn('Serving a read from the latest in-memory portal snapshot while MongoDB Atlas reconnects:', error.message))
    } else {
      try { await refreshPortalStateFromAtlas({ required: true }) }
      catch { return json(res, 503, { error: 'MongoDB Atlas is temporarily unavailable. Please retry this update shortly.' }) }
    }
  }
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, name: 'Gouri Agency Portal API', storage: 'MongoDB Atlas' })
  if (req.method === 'GET' && holidayCalendarMatch) {
    const year = Number(holidayCalendarMatch[1])
    const stateCode = holidayCalendarMatch[2].toUpperCase()
    const state = indiaHolidayStates.find(item => item.code === stateCode || item.codes?.includes(stateCode))
    if (year < 2026 || year > 2100 || !state) return holidayJson(res, 400, { error: 'Choose a supported calendar year and state.' }, 'no-store')
    if (year === 2026) {
      const calendar = createIndiaHolidayCalendar(year, stateCode)
      if (calendar) return holidayJson(res, 200, calendar, 'public, max-age=86400, stale-if-error=604800')
    }
    try {
      return holidayJson(res, 200, await getPublicHolidayCalendar(year, state), 'public, max-age=900, stale-if-error=86400')
    } catch (error) {
      return holidayJson(res, 503, { error: `The ${year} holiday list is not published by the data source yet. ${error.message}` }, 'no-store')
    }
  }
  const sliderImageMatch = /^\/api\/home-slider\/images\/([a-f0-9-]{36}\.(?:jpg|png))$/.exec(url.pathname)
  if (req.method === 'GET' && sliderImageMatch) {
    const fileName = sliderImageMatch[1]
    const image = homeSlider.images.find(item => item && `${item.id}.${item.type === 'image/jpeg' ? 'jpg' : 'png'}` === fileName)
    if (!image) return json(res, 404, { error: 'Home slider image not found.' })
    try {
      const file = await mongoDb.collection('home_slider_assets.files').findOne({ 'metadata.assetId': image.id, 'metadata.kind': 'home-slider' })
      if (!file) return json(res, 404, { error: 'Home slider image not found.' })
      const bytes = await readGridFsBuffer(homeSliderAssetBucket, file._id)
      res.writeHead(200, { 'Content-Type': image.type, 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' })
      return res.end(bytes)
    } catch {
      return json(res, 404, { error: 'Home slider image not found.' })
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/home-slider') return json(res, 200, homeSliderPayload())
  if (req.method === 'GET' && url.pathname === '/api/notices') return json(res, 200, { notices })
  if (req.method === 'GET' && url.pathname === '/api/order-intake-status') return json(res, 200, paymentSettings.orderIntake)
  const ifscMatch = /^\/api\/ifsc\/([A-Z]{4}0[A-Z0-9]{6})$/i.exec(url.pathname)
  if (req.method === 'GET' && ifscMatch) {
    const ifscCode = ifscMatch[1].toUpperCase()
    const cached = ifscLookupCache.get(ifscCode)
    if (cached && cached.expiresAt > Date.now()) return json(res, cached.status, cached.payload)
    try {
      const response = await fetch(`https://ifsc.razorpay.com/${encodeURIComponent(ifscCode)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(7000)
      })
      const result = await response.json().catch(() => null)
      const bankName = String(result?.BANK || '').trim()
      const branch = String(result?.BRANCH || '').trim()
      if (!response.ok || !bankName || !branch || String(result?.IFSC || '').toUpperCase() !== ifscCode) {
        const payload = { error: 'IFSC branch details could not be found. Enter the bank and branch manually.' }
        ifscLookupCache.set(ifscCode, { status: 404, payload, expiresAt: Date.now() + 5 * 60_000 })
        return json(res, 404, payload)
      }
      const payload = { ifscCode, bankName, branch }
      ifscLookupCache.set(ifscCode, { status: 200, payload, expiresAt: Date.now() + 24 * 60 * 60_000 })
      if (ifscLookupCache.size > 2000) for (const [key, value] of ifscLookupCache) if (value.expiresAt <= Date.now()) ifscLookupCache.delete(key)
      return json(res, 200, payload)
    } catch {
      return json(res, 503, { error: 'IFSC lookup is temporarily unavailable. Enter the bank and branch manually.' })
    }
  }
  const pincodeMatch = /^\/api\/pincode\/(\d{6})$/.exec(url.pathname)
  if (req.method === 'GET' && pincodeMatch) {
    const pincode = pincodeMatch[1]
    const cached = pincodeLookupCache.get(pincode)
    if (cached && cached.expiresAt > Date.now()) return json(res, cached.status, cached.payload)
    try {
      const response = await fetch(`https://api.postalpincode.in/pincode/${pincode}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(7000) })
      const result = await response.json().catch(() => null)
      const offices = Array.isArray(result) && result[0]?.Status === 'Success' && Array.isArray(result[0]?.PostOffice) ? result[0].PostOffice : []
      const office = offices.find(item => String(item.Pincode || '') === pincode && item.District && item.State) || offices[0]
      if (!response.ok || !office) {
        const payload = { error: 'We could not find this PIN code. Enter the city, state, and country manually.' }
        pincodeLookupCache.set(pincode, { status: 404, payload, expiresAt: Date.now() + 5 * 60_000 })
        return json(res, 404, payload)
      }
      const citySource = String(office.Taluk || office.Block || office.District || '').trim()
      const city = citySource.replace(/\s+mc$/i, '').trim()
      const payload = { pincode, city: city || String(office.District || '').trim(), state: String(office.State || '').trim(), country: String(office.Country || 'India').trim() }
      pincodeLookupCache.set(pincode, { status: 200, payload, expiresAt: Date.now() + 24 * 60 * 60_000 })
      if (pincodeLookupCache.size > 2000) for (const [key, value] of pincodeLookupCache) if (value.expiresAt <= Date.now()) pincodeLookupCache.delete(key)
      return json(res, 200, payload)
    } catch {
      return json(res, 503, { error: 'PIN code lookup is temporarily unavailable. Enter the city, state, and country manually.' })
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/gst/verify') {
    const body = await readJson(req, res)
    if (!body) return
    const gstin = normalizeGst(body.gstin)
    if (!GSTIN_FORMAT.test(gstin)) return json(res, 400, { verified: false, manualEntry: true, error: 'Enter a valid 15-character GSTIN to try automatic verification.' })
    const manualEntry = reason => json(res, 200, { verified: false, manualEntry: true, reason })
    if (!GSTIN_API_KEY) return manualEntry('not_configured')
    try {
      const response = await fetch(`https://www.gstinapi.in/v1/gstin/${encodeURIComponent(gstin)}?include=profile`, {
        headers: { 'x-api-key': GSTIN_API_KEY, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000)
      })
      const result = await response.json().catch(() => null)
      const record = result?.data
      const registeredName = String(record?.trade_name || record?.legal_name || '').trim()
      const address = String(record?.address || '').trim()
      const pincode = String(record?.pincode || record?.address_details?.pincode || '').trim()
      const city = String(record?.city || record?.address_details?.city || record?.address_details?.district || '').trim()
      const state = String(record?.state || record?.address_details?.state || '').trim()
      const country = 'India'
      if (!response.ok || result?.success !== true || normalizeGst(result?.gstin) !== gstin || !registeredName || !address) {
        if (response.status === 404) return manualEntry('not_found')
        if (response.status === 402 || response.status === 429) return manualEntry('quota')
        if (response.status === 401 || response.status === 403) return manualEntry('configuration')
        return manualEntry('unavailable')
      }
      const issuedAt = Date.now()
      return json(res, 200, {
        verified: true,
        gstin,
        registeredName,
        address,
        pincode: /^\d{6}$/.test(pincode) ? pincode : '',
        city,
        state,
        country,
        status: String(record.status || ''),
        creditsRemaining: Number.isFinite(Number(result.credits_remaining)) ? Number(result.credits_remaining) : null,
        proof: issueGstVerificationProof(gstin, registeredName, address, { pincode: /^\d{6}$/.test(pincode) ? pincode : '', city, state, country }, issuedAt)
      })
    } catch {
      return manualEntry('unavailable')
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/webhooks/razorpay') {
    if (!RAZORPAY_WEBHOOK_SECRET) return json(res, 503, { error: 'Razorpay webhook secret is not configured on the server.' })
    const rawBody = await readRawBody(req)
    if (!rawBody) return json(res, 413, { error: 'Webhook payload is too large.' })
    const signature = String(req.headers['x-razorpay-signature'] || '')
    const provided = /^[a-f0-9]{64}$/i.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0)
    const expected = createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest()
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json(res, 401, { error: 'Razorpay webhook signature is invalid.' })
    let event
    try { event = JSON.parse(rawBody.toString('utf8')) } catch { return json(res, 400, { error: 'Webhook payload is invalid JSON.' }) }
    const entity = event.event.startsWith('payment.') ? event.payload?.payment?.entity : event.payload?.refund?.entity
    const eventId = String(req.headers['x-razorpay-event-id'] || '')
    const eventKey = eventId || `body:${createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex')}`
    if (processedRazorpayEvents.has(eventKey)) return json(res, 200, { ok: true, duplicate: true })
    if (event.event === 'payment.captured') {
      if (!entity?.id || !entity.order_id || entity.status !== 'captured' || entity.captured !== true) return json(res, 400, { error: 'Captured payment details are incomplete.' })
      const order = orders.find(item => (item.payments || []).some(payment => payment.razorpayOrderId === entity.order_id))
      if (!order) return json(res, 404, { error: 'No portal order matches this Razorpay payment.' })
      const payment = (order.payments || []).find(item => item.razorpayOrderId === entity.order_id)
      if (payment?.batchId) {
        await reconcilePaymentBatch(payment.batchId, 'Razorpay')
      } else if (!payment || Math.round(Number(payment.amount) * 100) !== Number(entity.amount) || entity.currency !== 'INR') {
        return json(res, 409, { error: 'Captured payment amount or currency does not match the portal checkout.' })
      } else {
        await finalizeConfirmedPayment(order, payment, { status: 'Paid', reference: entity.id, razorpayPaymentId: entity.id })
        payment.reconcileUntil = ''
        payment.nextReconcileAt = ''
        if (order.status === 'Cancelled') {
          try { await initiateRazorpayRefund(order, payment, { reason: 'Late capture after client cancellation', suffix: 'late-cancel' }) }
          catch (error) { await markRazorpayRefundFailed(order, payment, error, { notify: true }) }
        }
      }
    } else if (event.event === 'payment.failed') {
      if (!entity?.id || !entity.order_id || entity.status !== 'failed') return json(res, 400, { error: 'Failed payment details are incomplete.' })
      const order = orders.find(item => (item.payments || []).some(payment => payment.razorpayOrderId === entity.order_id))
      if (!order) return json(res, 404, { error: 'No portal order matches this Razorpay payment.' })
      const payment = (order.payments || []).find(item => item.razorpayOrderId === entity.order_id)
      if (payment?.batchId) await reconcilePaymentBatch(payment.batchId, 'Razorpay')
      else {
        if (!payment || Math.round(Number(payment.amount) * 100) !== Number(entity.amount) || entity.currency !== 'INR') return json(res, 409, { error: 'Failed payment amount or currency does not match the portal checkout.' })
        await markRazorpayPaymentFailed(order, payment, entity, entity.error_description || entity.error_reason || '')
      }
    } else if (['refund.processed', 'refund.failed', 'refund.created', 'refund.updated'].includes(event.event)) {
      if (!entity?.id || !entity.payment_id || !['processed', 'failed', 'pending'].includes(entity.status)) return json(res, 400, { error: 'Refund details are incomplete.' })
      const candidates = orders.flatMap(item => (item.payments || []).filter(payment => payment.razorpayPaymentId === entity.payment_id).map(payment => ({ order: item, payment })))
      const match = candidates.find(({ payment }) => payment.refunds?.some(refund => refund.id === entity.id || (entity.receipt && refund.receipt === entity.receipt))) || candidates[0]
      if (!match) return json(res, 404, { error: 'No portal payment matches this Razorpay refund.' })
      const { order, payment } = match
      payment.refunds ||= []
      const refund = payment.refunds.find(item => item.id === entity.id || (item.receipt && item.receipt === entity.receipt)) || {}
      Object.assign(refund, { id: entity.id, receipt: entity.receipt || refund.receipt || '', amount: Number(entity.amount || 0) / 100, status: entity.status, reason: refund.reason || 'Client order cancellation', updatedAt: new Date().toISOString() })
      if (!payment.refunds.includes(refund)) payment.refunds.push(refund)
      const previousRefundStatus = payment.refundStatus
      updateRefundTotals(order, payment)
      persistPortalState()
      if (previousRefundStatus !== payment.refundStatus) await emailPaymentStateChange(order, 'Refund status updated', [['Payment reference', payment.razorpayPaymentId], ['Razorpay refund ID', entity.id], ['Refund status', payment.refundStatus], ['Refunded amount', formatINR(payment.amountRefunded)], ['Order balance', formatINR(order.status === 'Cancelled' ? 0 : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0)))]], `Razorpay updated the refund status for order ${order.id}. The current refund details are listed below.`)
    }
    processedRazorpayEvents.add(eventKey)
    persistPortalState()
    return json(res, 200, { ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/api/webhooks/cashfree') {
    if (!CASHFREE_CONFIGURED) return json(res, 503, { error: 'Cashfree API credentials are not configured on the server.' })
    const rawBody = await readRawBody(req)
    if (!rawBody) return json(res, 413, { error: 'Webhook payload is too large.' })
    const timestamp = String(req.headers['x-webhook-timestamp'] || '')
    const signature = String(req.headers['x-webhook-signature'] || '')
    const provided = /^[A-Za-z0-9+/]+={0,2}$/.test(signature) ? Buffer.from(signature, 'base64') : Buffer.alloc(0)
    const expected = createHmac('sha256', CASHFREE_CLIENT_SECRET).update(timestamp + rawBody.toString('utf8')).digest()
    if (!timestamp || provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json(res, 401, { error: 'Cashfree webhook signature is invalid.' })
    let event
    try { event = JSON.parse(rawBody.toString('utf8')) } catch { return json(res, 400, { error: 'Webhook payload is invalid JSON.' }) }
    const eventKey = String(req.headers['x-idempotency-key'] || req.headers['x-idempotency-header'] || `body:${createHmac('sha256', CASHFREE_CLIENT_SECRET).update(rawBody).digest('hex')}`)
    if (processedCashfreeEvents.has(eventKey)) return json(res, 200, { ok: true, duplicate: true })
    const eventType = String(event.type || '').toUpperCase()
    const webhookPayment = event.data?.payment
    const webhookRefund = event.data?.refund || event.data?.auto_refund
    const cashfreeOrderId = String(event.data?.order?.order_id || webhookRefund?.order_id || '')
    const order = orders.find(item => (item.payments || []).some(payment => payment.provider === 'Cashfree' && (payment.cashfreeOrderId === cashfreeOrderId || (webhookPayment?.cf_payment_id && payment.cashfreePaymentId === String(webhookPayment.cf_payment_id)))))
    if (order && ['PAYMENT_SUCCESS_WEBHOOK', 'PAYMENT_FAILED_WEBHOOK', 'PAYMENT_USER_DROPPED_WEBHOOK'].includes(eventType)) {
      const payment = (order.payments || []).find(item => item.provider === 'Cashfree' && item.cashfreeOrderId === cashfreeOrderId)
      if (payment) await reconcileCashfreePayment(order, payment)
    } else if (order && ['REFUND_STATUS_WEBHOOK', 'AUTO_REFUND_STATUS_WEBHOOK'].includes(eventType) && webhookRefund) {
      const candidates = orders.flatMap(item => (item.payments || []).filter(payment => payment.provider === 'Cashfree' && (payment.cashfreeOrderId === cashfreeOrderId || String(payment.cashfreePaymentId) === String(webhookRefund.cf_payment_id || ''))).map(payment => ({ order: item, payment })))
      const refundKey = String(webhookRefund.refund_id || webhookRefund.cf_refund_id || '')
      const match = candidates.find(({ payment }) => payment.refunds?.some(item => item.id === refundKey || item.providerRefundId === String(webhookRefund.cf_refund_id || ''))) || candidates[0]
      if (match) {
        const { order: refundOrder, payment } = match
        payment.refunds ||= []
        const refund = payment.refunds.find(item => item.id === refundKey || item.providerRefundId === String(webhookRefund.cf_refund_id || '')) || {}
        const previousStatus = payment.refundStatus
        updateCashfreeRefundRecord(payment, webhookRefund, refund)
        updateRefundTotals(refundOrder, payment)
        persistPortalState()
        if (previousStatus !== payment.refundStatus) await emailPaymentStateChange(refundOrder, 'Refund status updated', [['Payment provider', 'Cashfree'], ['Payment reference', payment.cashfreePaymentId || webhookRefund.cf_payment_id || ''], ['Cashfree refund ID', refund.id], ['Refund status', payment.refundStatus], ['Refunded amount', formatINR(payment.amountRefunded)], ['Order balance', formatINR(refundOrder.status === 'Cancelled' ? 0 : Math.max(0, Number(refundOrder.amountDue || 0) - Number(refundOrder.amountPaid || 0)))]], `Cashfree updated the refund status for order ${refundOrder.id}. The current refund details are listed below.`)
      }
    }
    processedCashfreeEvents.add(eventKey)
    persistPortalState()
    return json(res, 200, { ok: true, ignored: !order })
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(req, res)
    if (!body) return
    const identifier = String(body.identifier || body.email || '').trim()
    const { password, role } = body
    let isAdmin = role === 'admin' && normalizeEmailAddress(identifier) === adminCredentials.email && verifyAdminPassword(password, adminCredentials)
    if (role === 'admin' && !isAdmin && normalizeEmailAddress(identifier) !== adminCredentials.email) {
      await refreshPortalStateFromAtlas({ force: true }).catch(() => {})
      isAdmin = normalizeEmailAddress(identifier) === adminCredentials.email && verifyAdminPassword(password, adminCredentials)
    }
    if (role === 'admin' && !isAdmin) return json(res, 401, { error: 'Those admin details do not match.' })
    if (!identifier || (role === 'admin' && !password)) return json(res, 400, { error: role === 'admin' ? 'Enter your sign-in details.' : 'Enter your email, phone number, or GST number.' })
    let profile = !isAdmin ? findProfileByIdentifier(identifier) : null
    if (!isAdmin && !profile) {
      await refreshPortalStateFromAtlas({ force: true }).catch(() => {})
      profile = findProfileByIdentifier(identifier)
    }
    if (!isAdmin && !profile && !identifier.includes('@')) return json(res, 401, { error: 'No registered profile matches that phone number or GST number.' })
    const token = randomUUID()
    if (isAdmin) adminSessions.add(token)
    else clientSessions.set(token, profile?.id || null)
    const email = profile?.email || identifier
    return json(res, 200, { user: { name: isAdmin ? 'Gouri Admin' : (profile?.ownerName || profile?.shopName || email.split('@')[0]), email, role: isAdmin ? 'admin' : 'client', token, profile: dashboardProfile(profile) } })
  }
  const profileDocumentPath = /^\/api\/profiles\/([^/]+)\/documents\/(ownerPhoto|profilePhoto|signature|drugLicense|gstCopy)$/.exec(url.pathname)
  if (req.method === 'GET' && profileDocumentPath) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const adminAccess = Boolean(token && adminSessions.has(token))
    const clientProfileId = token ? clientSessions.get(token) : null
    if (!adminAccess && !clientProfileId) return json(res, 401, { error: 'Sign in required to view customer documents.' })
    let profileId
    try { profileId = decodeURIComponent(profileDocumentPath[1]) }
    catch { return json(res, 400, { error: 'Invalid profile ID.' }) }
    if (!adminAccess && clientProfileId !== profileId) return json(res, 403, { error: 'You can only view documents in your own customer profile.' })
    const profile = [...profilesByGst.values()].find(item => item.id === profileId)
    if (!profile) return json(res, 404, { error: 'Customer profile not found.' })
    const key = profileDocumentPath[2]
    const file = profile.attachments?.[key] || (key === 'profilePhoto' ? profile.attachments?.ownerPhoto : null)
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(file?.data || '')
    if (!file || !match) return json(res, 404, { error: 'This customer document is not available.' })
    const bytes = Buffer.from(match[2], 'base64')
    res.writeHead(200, {
      'Content-Type': match[1],
      'Content-Length': bytes.length,
      'Content-Disposition': `inline; filename="${safeFileName(file.name)}"`,
      'Cache-Control': 'private, max-age=300',
      'Vary': 'Authorization',
      'X-Content-Type-Options': 'nosniff'
    })
    return res.end(bytes)
  }
  if (req.method === 'GET' && url.pathname === '/api/profile') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const profileId = token ? clientSessions.get(token) : null
    const profile = profileId ? [...profilesByGst.values()].find(item => item.id === profileId) : null
    if (!profile) return json(res, 404, { error: 'No registered customer profile is linked to this sign-in.' })
    return json(res, 200, { profile: dashboardProfile(profile) })
  }
  if (req.method === 'POST' && url.pathname === '/api/client/statement/email') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    const profileId = clientSessions.get(token)
    const profile = profileId ? [...profilesByGst.values()].find(item => item.id === profileId) : null
    if (!profile) return json(res, 404, { error: 'No registered customer profile is linked to this sign-in.' })
    const body = await readJson(req, res)
    if (!body) return
    const fromDate = body.fromDate
    const toDate = body.toDate
    if (!validStatementDate(fromDate) || !validStatementDate(toDate) || fromDate > toDate) {
      return json(res, 400, { error: 'Choose a valid statement start and end date.' })
    }
    try {
      const accountOrders = orders.filter(order => order.profileId === profile.id)
      const job = await queueStatementEmail(profile, accountOrders, fromDate, toDate)
      return json(res, 202, { emailStatus: job.status, to: profile.email, filename: job.attachments?.[0]?.filename || `${safeFileName(profile.shopName)}-statement.pdf` })
    } catch (error) {
      return json(res, 400, { error: error.message || 'Could not prepare the statement email.' })
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/client/profile/latest-ledger') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    const profileId = clientSessions.get(token)
    const profile = profileId ? [...profilesByGst.values()].find(item => item.id === profileId) : null
    if (!profile) return json(res, 404, { error: 'No registered customer profile is linked to this sign-in.' })
    return sendPdf(res, await ensureCurrentLedger(profile))
  }
  if (req.method === 'GET' && url.pathname === '/api/client/messages') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    const profileId = clientSessions.get(token)
    if (!profileId || ![...profilesByGst.values()].some(profile => profile.id === profileId)) return json(res, 404, { error: 'No registered customer profile is linked to this sign-in.' })
    return json(res, 200, { messages: communicationThreadForProfile(profileId) })
  }
  if (req.method === 'POST' && url.pathname === '/api/client/messages') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    const profileId = clientSessions.get(token)
    const profile = [...profilesByGst.values()].find(item => item.id === profileId)
    if (!profile) return json(res, 404, { error: 'No registered customer profile is linked to this sign-in.' })
    if (!emailAddressPattern.test(normalizeEmailAddress(profile.email))) return json(res, 409, { error: 'Add a valid registered email to your profile before sending a portal message.' })
    const body = await readJson(req, res)
    if (!body) return
    const fields = validateCommunicationPayload(body)
    if (fields.error) return json(res, 400, { error: fields.error })
    const message = queueCommunicationMessage({
      profile,
      senderRole: 'client',
      senderName: profile.ownerName || profile.shopName,
      senderEmail: profile.email,
      to: 'gouriagency185@gmail.com',
      ccEmails: ['upadhyayjagneswar@gmail.com'],
      subject: fields.subject,
      body: fields.body,
      upload: fields.upload
    })
    return json(res, 201, { message })
  }
  const clientMessageAttachmentPath = /^\/api\/client\/messages\/([a-f0-9-]{36})\/attachment$/.exec(url.pathname)
  if (req.method === 'GET' && clientMessageAttachmentPath) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    const profileId = clientSessions.get(token)
    const message = communicationMessages.find(item => item.id === clientMessageAttachmentPath[1] && item.profileId === profileId)
    if (!message?.attachment) return json(res, 404, { error: 'Message attachment not found.' })
    return sendCommunicationAttachment(res, message)
  }
  if (req.method === 'GET' && url.pathname === '/api/client/orders') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    const profileId = clientSessions.get(token)
    const clientOrders = profileId ? orders.filter(order => order.profileId === profileId) : []
    const profile = profileId ? [...profilesByGst.values()].find(item => item.id === profileId) || null : null
    const promoCode = isPromoCodeLive(paymentSettings.promoCode) ? paymentSettings.promoCode : null
    return json(res, 200, { orders: clientOrders.map(clientOrderForDashboard), profile: dashboardProfile(profile), razorpayKeyId: RAZORPAY_CONFIGURED ? RAZORPAY_KEY_ID : '', cashfreeEnabled: CASHFREE_CONFIGURED, cashfreeEnvironment: CASHFREE_ENVIRONMENT, bankTransferDetails: paymentSettings.bankTransfer, promoCode })
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/client/orders/') && url.pathname.endsWith('/promo')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    const profileId = clientSessions.get(token)
    const orderId = decodeURIComponent(url.pathname.slice('/api/client/orders/'.length, -'/promo'.length))
    const order = orders.find(item => item.id === orderId && item.profileId === profileId)
    if (!order) return json(res, 404, { error: 'Order not found in this customer profile.' })
    if (order.status === 'Cancelled') return json(res, 409, { error: 'Cancelled orders cannot use a promo code.' })
    if (order.promoApplied) return json(res, 409, { error: `Promo code ${order.promoApplied.code} has already been applied to this order.` })
    if (reservedPaymentTotal(order) > 0) return json(res, 409, { error: 'Wait for pending payments to be confirmed before applying a promo code.' })
    const body = await readJson(req, res)
    if (!body) return
    const promo = paymentSettings.promoCode
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : ''
    if (!isPromoCodeLive(promo)) return json(res, 409, { error: 'This promo code is outside its scheduled offer period or is turned off.' })
    if (!code || code !== promo.code) return json(res, 400, { error: 'That promo code is not valid. Check the code and try again.' })
    const balance = Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0))
    if (balance <= 0) return json(res, 409, { error: 'This order has no outstanding amount to discount.' })
    const rawDiscount = promo.discountType === 'percent' ? balance * promo.discountValue / 100 : promo.discountValue
    const discount = Math.round(Math.min(balance, rawDiscount) * 100) / 100
    if (discount <= 0) return json(res, 409, { error: 'This promo code does not apply a discount to the current balance.' })
    order.amountDueBeforePromo = Number(order.amountDue || 0)
    order.amountDue = Math.round(Math.max(0, Number(order.amountDue || 0) - discount) * 100) / 100
    order.promoApplied = { code: promo.code, discountType: promo.discountType, discountValue: promo.discountValue, discount, emoji: promo.emoji, appliedAt: new Date().toISOString() }
    order.amountDueUpdatedAt = order.promoApplied.appliedAt
    order.updatedAt = order.promoApplied.appliedAt
    if (order.amountDue > 0 && Number(order.amountPaid || 0) >= order.amountDue) {
      order.fullyPaidAt = order.promoApplied.appliedAt
      order.paymentEditLockedUntil = new Date(Date.now() + DAY_MS).toISOString()
    }
    const profile = [...profilesByGst.values()].find(item => item.id === profileId)
    const ledger = profile ? await refreshLatestLedger(profile, order) : null
    const changedFields = [['Promo code', promo.code], ['Discount applied', `-${formatINR(discount)}`], ['Outstanding after discount', formatINR(Math.max(0, order.amountDue - Number(order.amountPaid || 0))) ]]
    const emailJob = queueOrderUpdateEmail(profile, order, changedFields, ledger, { introduction: `Promo code ${promo.code} was applied to order ${order.id}.` })
    order.emailStatus = emailJob.status
    persistPortalState()
    return json(res, 200, { order: clientOrderForDashboard(order), promoApplied: order.promoApplied, emailStatus: emailJob.status })
  }
  if (req.method === 'DELETE' && /^\/api\/client\/orders\/[^/]+\/promo$/.test(url.pathname)) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    const orderId = decodeURIComponent(url.pathname.slice('/api/client/orders/'.length, -'/promo'.length))
    const order = orders.find(item => item.id === orderId && item.profileId === clientSessions.get(token))
    if (!order) return json(res, 404, { error: 'Order not found in this customer profile.' })
    if (order.status === 'Cancelled') return json(res, 409, { error: 'A promo code cannot be removed from a cancelled order.' })
    if (!order.promoApplied) return json(res, 409, { error: 'There is no promo code applied to this order.' })
    if (reservedPaymentTotal(order) > 0) return json(res, 409, { error: 'Wait for pending payments to finish before removing the promo code.' })
    const promo = order.promoApplied
    const restoredDue = Number(order.amountDueBeforePromo)
    if (!Number.isFinite(restoredDue) || restoredDue < Number(order.amountDue || 0)) return json(res, 409, { error: 'The original order total is unavailable, so the promo cannot be removed safely.' })
    const previousDue = Number(order.amountDue || 0)
    order.amountDue = Math.round(restoredDue * 100) / 100
    delete order.promoApplied
    delete order.amountDueBeforePromo
    const appliedFullyPaidLock = Date.parse(order.fullyPaidAt || '') === Date.parse(promo.appliedAt || '')
    if (appliedFullyPaidLock) {
      delete order.fullyPaidAt
      delete order.paymentEditLockedUntil
    }
    order.amountDueUpdatedAt = new Date().toISOString()
    order.updatedAt = order.amountDueUpdatedAt
    const profile = [...profilesByGst.values()].find(item => item.id === order.profileId)
    const ledger = profile ? await refreshLatestLedger(profile, order) : null
    const outstanding = Math.max(0, order.amountDue - Number(order.amountPaid || 0))
    const changedFields = [['Promo code removed', promo.code], ['Discount reversed', `+${formatINR(promo.discount)}`], ['Order due restored', `${formatINR(previousDue)} changed to ${formatINR(order.amountDue)}`], ['Outstanding balance', formatINR(outstanding)]]
    const emailJob = queueOrderUpdateEmail(profile, order, changedFields, ledger, { introduction: `Promo code ${promo.code} was removed from order ${order.id}; the original order total has been restored.` })
    order.emailStatus = emailJob.status
    persistPortalState()
    return json(res, 200, { order: clientOrderForDashboard(order), emailStatus: emailJob.status })
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/client/orders/') && url.pathname.includes('/payments/') && url.pathname.endsWith('/receipt')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    const receiptPath = /^\/api\/client\/orders\/([^/]+)\/payments\/([^/]+)\/receipt$/.exec(url.pathname)
    if (!receiptPath) return json(res, 404, { error: 'Payment receipt not found.' })
    const profileId = clientSessions.get(token)
    const order = orders.find(item => item.id === decodeURIComponent(receiptPath[1]) && item.profileId === profileId)
    if (!order) return json(res, 404, { error: 'Order not found in this customer profile.' })
    const payment = (order.payments || []).find(item => item.id === decodeURIComponent(receiptPath[2]))
    if (!payment) return json(res, 404, { error: 'Payment record not found.' })
    return sendPaymentReceipt(res, order, payment)
  }
  if (req.method === 'POST' && url.pathname === '/api/client/payment-batches/checkout') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    const profileId = clientSessions.get(token)
    const body = await readJson(req, res)
    if (!body) return
    const provider = body.provider === 'Cashfree' ? 'Cashfree' : body.provider === 'Razorpay' ? 'Razorpay' : ''
    if (!provider) return json(res, 400, { error: 'Choose Razorpay or Cashfree for a combined order payment.' })
    if (provider === 'Cashfree' && !CASHFREE_CONFIGURED) return json(res, 503, { error: 'Cashfree checkout is not configured on the server.' })
    if (provider === 'Razorpay' && !RAZORPAY_CONFIGURED) return json(res, 503, { error: 'Razorpay checkout is not configured on the server.' })
    const requestedIds = Array.isArray(body.orderIds) ? [...new Set(body.orderIds.map(value => String(value || '').trim()).filter(Boolean))] : []
    if (requestedIds.length < 2 || requestedIds.length > 100) return json(res, 400, { error: 'Select at least two orders, and no more than 100, to make a combined payment.' })
    const selectedOrders = requestedIds.map(id => orders.find(order => order.id === id && order.profileId === profileId))
    if (selectedOrders.some(order => !order)) return json(res, 404, { error: 'One or more selected orders do not belong to this client profile.' })
    const allocations = selectedOrders.map(order => {
      const reserved = reservedPaymentTotal(order)
      const amount = Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0) - reserved)
      return { order, amount: Math.round(amount * 100) / 100 }
    })
    if (allocations.some(({ order, amount }) => order.status === 'Cancelled' || amount <= 0)) return json(res, 409, { error: 'Every selected order must be active and have an unpaid balance available for payment. Refresh the list and select again.' })
    const totalAmount = Math.round(allocations.reduce((sum, item) => sum + item.amount, 0) * 100) / 100
    const amountPaise = Math.round(totalAmount * 100)
    if (amountPaise < 100) return json(res, 400, { error: 'Combined online payments must total at least INR 1.00.' })
    const profile = [...profilesByGst.values()].find(item => item.id === profileId)
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    const batchId = `BATCH-${randomUUID()}`
    const requestHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
    const requestProtocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()
    const publicUrl = PORTAL_PUBLIC_URL || `${requestProtocol}://${requestHost}`
    if (!/^https:\/\//i.test(publicUrl) && provider === 'Cashfree') return json(res, 500, { error: 'Set PORTAL_PUBLIC_URL to the public HTTPS website address.' })
    try {
      let checkoutDetails
      if (provider === 'Razorpay') {
        const receipt = `GAB-${randomUUID().replace(/-/g, '').slice(0, 20)}`.slice(0, 40)
        const razorpayOrder = await razorpayRequest('orders', { method: 'POST', body: {
          amount: amountPaise,
          currency: 'INR',
          receipt,
          notes: { gouri_batch_id: batchId, gouri_order_ids: requestedIds.join(',').slice(0, 250) }
        } })
        if (!razorpayOrder.id || Number(razorpayOrder.amount) !== amountPaise || razorpayOrder.currency !== 'INR') throw new Error('Razorpay did not create a matching combined-payment order.')
        checkoutDetails = { keyId: RAZORPAY_KEY_ID, razorpayOrderId: String(razorpayOrder.id) }
      } else {
        const customerPhone = String(profile?.mobile || '').replace(/\D/g, '').slice(-10)
        if (!/^\d{10}$/.test(customerPhone)) return json(res, 400, { error: 'A valid registered 10-digit mobile number is required for Cashfree checkout.' })
        const cashfreeOrderId = `cfb_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        const returnUrl = new URL('/', publicUrl)
        returnUrl.searchParams.set('cashfree_order_id', cashfreeOrderId)
        const cashfreeOrder = await cashfreeRequest('orders', { method: 'POST', body: {
          order_id: cashfreeOrderId,
          order_amount: totalAmount,
          order_currency: 'INR',
          customer_details: {
            customer_id: String(profile?.id || profileId || 'client').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50),
            customer_name: String(profile?.ownerName || profile?.shopName || 'Gouri Agency Client').slice(0, 100),
            customer_email: String(profile?.email || '').slice(0, 100),
            customer_phone: customerPhone
          },
          order_meta: { return_url: returnUrl.toString(), notify_url: new URL('/api/webhooks/cashfree', publicUrl).toString() },
          order_note: `Combined payment for ${requestedIds.length} Gouri Agency orders`.slice(0, 200),
          order_tags: { gouri_batch_id: batchId, gouri_order_count: String(requestedIds.length) }
        } })
        if (!cashfreeOrder.payment_session_id || !cashfreeOrder.order_id) throw new Error('Cashfree did not return a valid combined payment session.')
        checkoutDetails = { cashfreeOrderId: String(cashfreeOrder.order_id), paymentSessionId: String(cashfreeOrder.payment_session_id), environment: CASHFREE_ENVIRONMENT }
      }
      for (const { order, amount } of allocations) {
        const payment = {
          id: `PAY-${randomUUID().slice(0, 8).toUpperCase()}`,
          amount,
          batchId,
          batchTotalAmount: totalAmount,
          batchOrderIds: requestedIds,
          reference: `${provider} combined checkout started`,
          provider,
          status: provider === 'Cashfree' ? 'Awaiting Cashfree payment' : 'Awaiting Razorpay payment',
          submittedAt: now,
          expiresAt,
          ...(provider === 'Cashfree' ? { cashfreeOrderId: checkoutDetails.cashfreeOrderId, cashfreePaymentSessionId: checkoutDetails.paymentSessionId } : { razorpayOrderId: checkoutDetails.razorpayOrderId })
        }
        order.payments ||= []
        order.payments.unshift(payment)
      }
      persistPortalState()
      return json(res, 201, {
        batchId,
        provider,
        amount: totalAmount,
        amountPaise,
        currency: 'INR',
        orders: allocations.map(({ order }) => clientOrderForDashboard(order)),
        ...checkoutDetails
      })
    } catch (error) {
      return json(res, 502, { error: error.message || `Could not start ${provider} combined checkout.` })
    }
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/client/payment-batches/') && url.pathname.endsWith('/reconcile')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    const batchId = decodeURIComponent(url.pathname.slice('/api/client/payment-batches/'.length, -'/reconcile'.length))
    const profileId = clientSessions.get(token)
    const entries = getPaymentBatchEntries(batchId)
    if (!entries.length || entries.some(entry => entry.order.profileId !== profileId)) return json(res, 404, { error: 'Combined payment was not found in this customer profile.' })
    let result
    try { result = await reconcilePaymentBatch(batchId, entries[0].payment.provider) }
    catch (error) { return json(res, 502, { error: error.message || 'Could not reconcile the combined payment yet.' }) }
    const updatedEntries = getPaymentBatchEntries(batchId)
    const updatedOrders = [...new Map(updatedEntries.map(entry => [entry.order.id, entry.order])).values()]
    return json(res, 200, {
      batchId,
      status: result.status,
      provider: result.provider || entries[0].payment.provider,
      orders: updatedOrders.map(clientOrderForDashboard),
      allocations: updatedEntries.map(({ order, payment }) => ({ orderId: order.id, order: clientOrderForDashboard(order), payment })),
      emailStatus: updatedEntries.every(entry => entry.payment.emailStatus === 'sent') ? 'sent' : updatedEntries.some(entry => entry.payment.emailStatus === 'needs_configuration') ? 'needs_configuration' : 'queued'
    })
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/client/orders/') && url.pathname.endsWith('/cashfree-checkout')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    if (!CASHFREE_CONFIGURED) return json(res, 503, { error: 'Cashfree checkout is not configured. Add CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET to the server environment.' })
    const profileId = clientSessions.get(token)
    const orderId = decodeURIComponent(url.pathname.slice('/api/client/orders/'.length, -'/cashfree-checkout'.length))
    const order = orders.find(item => item.id === orderId && item.profileId === profileId)
    if (!order) return json(res, 404, { error: 'Order not found in this customer profile.' })
    if (order.status === 'Cancelled') return json(res, 409, { error: 'This order has been cancelled and cannot accept new payments.' })
    const body = await readJson(req, res)
    if (!body) return
    const amount = Number(body.amount)
    const availableDue = profileAvailableBalance(profileId)
    if (!Number.isFinite(amount) || Math.round(amount * 100) < 100 || amount > availableDue + 0.001) return json(res, 400, { error: 'Enter a Cashfree payment amount of at least ₹1 and no more than this profile’s total outstanding balance.' })
    const profile = [...profilesByGst.values()].find(item => item.id === profileId)
    const customerPhone = String(profile?.mobile || order.mobile || '').replace(/\D/g, '').slice(-10)
    if (!/^\d{10}$/.test(customerPhone)) return json(res, 400, { error: 'A valid 10-digit registered mobile number is required for Cashfree checkout. Update the profile and retry.' })
    const requestHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
    const requestProtocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()
    const publicUrl = PORTAL_PUBLIC_URL || `${requestProtocol}://${requestHost}`
    if (!/^https?:\/\//i.test(publicUrl)) return json(res, 500, { error: 'Set PORTAL_PUBLIC_URL to the public HTTPS website address.' })
    const cashfreeOrderId = `cf_${order.id}_${randomUUID().replace(/-/g, '').slice(0, 10)}`
    const returnUrl = new URL('/', publicUrl)
    returnUrl.searchParams.set('cashfree_order_id', cashfreeOrderId)
    try {
      const cashfreeOrder = await cashfreeRequest('orders', { method: 'POST', body: {
        order_id: cashfreeOrderId,
        order_amount: Math.round(amount * 100) / 100,
        order_currency: 'INR',
        customer_details: {
          customer_id: String(profile?.id || order.profileId || 'client').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50),
          customer_name: String(profile?.ownerName || order.ownerName || profile?.shopName || order.shopName || 'Gouri Agency Client').slice(0, 100),
          customer_email: String(profile?.email || order.email || '').slice(0, 100),
          customer_phone: customerPhone
        },
        order_meta: {
          return_url: returnUrl.toString(),
          notify_url: new URL('/api/webhooks/cashfree', publicUrl).toString()
        },
        order_note: `Payment for Gouri Agency order ${order.id}`.slice(0, 200),
        order_tags: { gouri_order_id: order.id }
      } })
      if (!cashfreeOrder.payment_session_id || !cashfreeOrder.order_id) throw new Error('Cashfree did not return a valid payment session.')
      const payment = {
        id: `PAY-${randomUUID().slice(0, 8).toUpperCase()}`,
        amount: Math.round(amount * 100) / 100,
        reference: 'Cashfree checkout started',
        provider: 'Cashfree',
        status: 'Awaiting Cashfree payment',
        cashfreeOrderId: String(cashfreeOrder.order_id),
        cashfreePaymentSessionId: String(cashfreeOrder.payment_session_id),
        submittedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      }
      order.payments ||= []
      order.payments.unshift(payment)
      persistPortalState()
      return json(res, 201, { order: clientOrderForDashboard(order), paymentSessionId: payment.cashfreePaymentSessionId, cashfreeOrderId: payment.cashfreeOrderId, environment: CASHFREE_ENVIRONMENT })
    } catch (error) {
      return json(res, 502, { error: error.message || 'Could not start Cashfree checkout.' })
    }
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/client/orders/') && url.pathname.endsWith('/cashfree-reconcile')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    if (!CASHFREE_CONFIGURED) return json(res, 503, { error: 'Cashfree payment reconciliation is not configured.' })
    const profileId = clientSessions.get(token)
    const orderId = decodeURIComponent(url.pathname.slice('/api/client/orders/'.length, -'/cashfree-reconcile'.length))
    const order = orders.find(item => item.id === orderId && item.profileId === profileId)
    if (!order) return json(res, 404, { error: 'Order not found in this customer profile.' })
    const body = await readJson(req, res)
    if (!body) return
    const payment = (order.payments || []).find(item => item.provider === 'Cashfree' && item.cashfreeOrderId === String(body.cashfreeOrderId || ''))
    if (!payment) return json(res, 404, { error: 'Cashfree checkout record not found.' })
    try {
      const result = payment.status === 'Paid' ? { status: 'Paid', payment } : await reconcileCashfreePayment(order, payment)
      return json(res, 200, { order: clientOrderForDashboard(order), payment, reconciliationStatus: result.status, refundSummary: result.refundSummary || '', emailStatus: payment.emailStatus || null })
    } catch (error) {
      return json(res, 502, { error: error.message || 'Could not reconcile this Cashfree payment.' })
    }
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/client/orders/') && url.pathname.endsWith('/checkout')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    if (!RAZORPAY_CONFIGURED) return json(res, 503, { error: 'Razorpay checkout is not configured. Add the API key ID and secret on the server.' })
    const profileId = clientSessions.get(token)
    if (!profileId) return json(res, 403, { error: 'A registered customer profile is required to pay an order.' })
    const orderId = decodeURIComponent(url.pathname.slice('/api/client/orders/'.length, -'/checkout'.length))
    const order = orders.find(item => item.id === orderId && item.profileId === profileId)
    if (!order) return json(res, 404, { error: 'Order not found in this customer profile.' })
    if (order.status === 'Cancelled') return json(res, 409, { error: 'This order has been cancelled and cannot accept new payments.' })
    const body = await readJson(req, res)
    if (!body) return
    const amount = Number(body.amount)
    const amountPaise = Math.round(amount * 100)
    const availableDue = profileAvailableBalance(profileId)
    if (!Number.isFinite(amount) || amountPaise < 100 || amount > availableDue + 0.001) return json(res, 400, { error: 'Enter an online payment amount of at least ₹1 and no more than this profile’s total outstanding balance.' })
    try {
      const receipt = `${order.id}-${randomUUID().replace(/-/g, '').slice(0, 12)}`.slice(0, 40)
      const razorpayOrder = await razorpayRequest('orders', { method: 'POST', body: { amount: amountPaise, currency: 'INR', receipt, notes: { gouri_order_id: order.id } } })
      const payment = {
        id: `PAY-${randomUUID().slice(0, 8).toUpperCase()}`,
        amount: amountPaise / 100,
        reference: 'Razorpay checkout started',
        provider: 'Razorpay',
        status: 'Awaiting Razorpay payment',
        razorpayOrderId: razorpayOrder.id,
        submittedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      }
      order.payments ||= []
      order.payments.unshift(payment)
      persistPortalState()
      return json(res, 201, { order: clientOrderForDashboard(order), keyId: RAZORPAY_KEY_ID, amount: amountPaise, currency: 'INR', razorpayOrderId: razorpayOrder.id })
    } catch (error) {
      return json(res, 502, { error: error.message || 'Could not start Razorpay checkout.' })
    }
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/client/orders/') && url.pathname.endsWith('/payments/reconcile')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    if (!RAZORPAY_CONFIGURED) return json(res, 503, { error: 'Razorpay reconciliation is not configured.' })
    const profileId = clientSessions.get(token)
    const orderId = decodeURIComponent(url.pathname.slice('/api/client/orders/'.length, -'/payments/reconcile'.length))
    const order = orders.find(item => item.id === orderId && item.profileId === profileId)
    if (!order) return json(res, 404, { error: 'Order not found in this customer profile.' })
    const body = await readJson(req, res)
    if (!body) return
    const payment = (order.payments || []).find(item => item.provider === 'Razorpay' && item.razorpayOrderId === String(body.razorpayOrderId || ''))
    if (!payment) return json(res, 404, { error: 'Razorpay checkout record not found.' })
    try {
      const result = payment.status === 'Paid' ? { status: 'Paid', payment } : await reconcileRazorpayPayment(order, payment)
      return json(res, 200, { order: clientOrderForDashboard(order), payment, reconciliationStatus: result.status, refundSummary: result.refundSummary || '', emailStatus: payment.emailStatus || null })
    } catch (error) {
      return json(res, 502, { error: error.message || 'Could not reconcile this Razorpay payment.' })
    }
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/client/orders/') && url.pathname.endsWith('/cancel')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    const profileId = clientSessions.get(token)
    const orderId = decodeURIComponent(url.pathname.slice('/api/client/orders/'.length, -'/cancel'.length))
    const order = orders.find(item => item.id === orderId && item.profileId === profileId)
    if (!order) return json(res, 404, { error: 'Order not found in this customer profile.' })
    const result = await cancelOrderAndRequestRefund(order, 'Client')
    if (result.error) return json(res, result.statusCode || 409, { error: result.error })
    return json(res, 200, { order: clientOrderForDashboard(result.order), refundSummary: result.refundSummary, emailStatus: result.emailStatus })
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/orders/') && url.pathname.endsWith('/cancel')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const orderId = decodeURIComponent(url.pathname.slice('/api/orders/'.length, -'/cancel'.length))
    const order = orders.find(item => item.id === orderId)
    if (!order) return json(res, 404, { error: 'Order not found.' })
    const result = await cancelOrderAndRequestRefund(order, 'Admin')
    if (result.error) return json(res, result.statusCode || 409, { error: result.error })
    return json(res, 200, { order: orderForDashboard(result.order), refundSummary: result.refundSummary, emailStatus: result.emailStatus })
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/client/orders/') && url.pathname.endsWith('/payments/verify')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    if (!RAZORPAY_CONFIGURED) return json(res, 503, { error: 'Razorpay checkout is not configured.' })
    const profileId = clientSessions.get(token)
    if (!profileId) return json(res, 403, { error: 'A registered customer profile is required to pay an order.' })
    const orderId = decodeURIComponent(url.pathname.slice('/api/client/orders/'.length, -'/payments/verify'.length))
    const order = orders.find(item => item.id === orderId && item.profileId === profileId)
    if (!order) return json(res, 404, { error: 'Order not found in this customer profile.' })
    const body = await readJson(req, res)
    if (!body) return
    const payment = (order.payments || []).find(item => item.razorpayOrderId === body.razorpay_order_id)
    if (!payment) return json(res, 404, { error: 'Razorpay checkout record not found.' })
    if (payment.status === 'Paid') return json(res, 200, { order: clientOrderForDashboard(order), payment })
    if (!['Awaiting Razorpay payment', 'Failed', 'Cancelled', 'Razorpay payment processing'].includes(payment.status)) return json(res, 400, { error: 'This checkout is no longer active.' })
    const paymentId = String(body.razorpay_payment_id || '')
    const providedSignature = Buffer.from(String(body.razorpay_signature || ''), 'hex')
    const expectedSignature = createHmac('sha256', RAZORPAY_KEY_SECRET).update(`${payment.razorpayOrderId}|${paymentId}`).digest()
    if (!paymentId || providedSignature.length !== expectedSignature.length || !timingSafeEqual(providedSignature, expectedSignature)) {
      return json(res, 400, { error: 'Razorpay payment signature could not be verified.' })
    }
    try {
      let providerPayment = await razorpayRequest(`payments/${encodeURIComponent(paymentId)}`)
      if (providerPayment.order_id !== payment.razorpayOrderId || providerPayment.amount !== Math.round(payment.amount * 100) || providerPayment.currency !== 'INR') {
        return json(res, 400, { error: 'Razorpay payment details do not match this order.' })
      }
      if (providerPayment.status === 'authorized') {
        await razorpayRequest(`payments/${encodeURIComponent(paymentId)}/capture`, { method: 'POST', body: { amount: providerPayment.amount, currency: 'INR' } })
        providerPayment = await razorpayRequest(`payments/${encodeURIComponent(paymentId)}`)
      }
      if (providerPayment.status === 'failed') {
        await markRazorpayPaymentFailed(order, payment, providerPayment, providerPayment.error_description || providerPayment.error_reason || '')
        return json(res, 409, { error: providerPayment.error_description || 'Razorpay marked this payment as failed. You can retry the payment.' , order: clientOrderForDashboard(order), payment })
      }
      let finalized
      if (providerPayment.status !== 'captured' || providerPayment.captured !== true) {
        const result = await reconcileRazorpayPayment(order, payment)
        if (result.status !== 'Paid') return json(res, 409, { error: result.status === 'Failed' ? 'Razorpay marked this payment as failed. You can retry the payment.' : 'Razorpay is still confirming this payment. Refresh this page shortly.', order: clientOrderForDashboard(order), payment })
        finalized = { order, payment }
      } else {
        finalized = await finalizeConfirmedPayment(order, payment, { status: 'Paid', reference: paymentId, razorpayPaymentId: paymentId })
      }
      payment.reconcileUntil = ''
      payment.nextReconcileAt = ''
      let refundSummary = ''
      if (order.status === 'Cancelled') {
        try { await initiateRazorpayRefund(order, payment, { reason: 'Late capture after client cancellation', suffix: 'late-cancel' }); refundSummary = payment.refundStatus }
        catch (error) { await markRazorpayRefundFailed(order, payment, error, { notify: true }); refundSummary = 'failed' }
      }
      return json(res, 200, { order: clientOrderForDashboard(finalized.order), payment: finalized.payment, refundSummary, emailStatus: finalized.payment.emailStatus || 'needs_configuration' })
    } catch (error) {
      return json(res, 502, { error: error.message || 'Could not verify the Razorpay payment.' })
    }
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/client/orders/') && url.pathname.endsWith('/payments')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    const profileId = clientSessions.get(token)
    if (!profileId) return json(res, 403, { error: 'A registered customer profile is required to pay an order.' })
    const orderId = decodeURIComponent(url.pathname.slice('/api/client/orders/'.length, -'/payments'.length))
    const order = orders.find(item => item.id === orderId && item.profileId === profileId)
    if (!order) return json(res, 404, { error: 'Order not found in this customer profile.' })
    if (order.status === 'Cancelled') return json(res, 409, { error: 'This order has been cancelled and cannot accept new payments.' })
    const body = await readJson(req, res)
    if (!body) return
    const amount = Number(body.amount)
    const reference = typeof body.reference === 'string' ? body.reference.trim() : ''
    const provider = ['IMPS', 'NEFT', 'RTGS'].includes(body.provider) ? body.provider : ''
    const availableDue = profileAvailableBalance(profileId)
    if (!Number.isFinite(amount) || amount <= 0 || amount > availableDue + 0.001) return json(res, 400, { error: 'Enter a payment amount up to this profile’s total outstanding balance.' })
    if (!provider) return json(res, 400, { error: 'Choose IMPS, NEFT, or RTGS for the bank transfer.' })
    if (!/^[A-Za-z0-9/-]{6,64}$/.test(reference)) return json(res, 400, { error: 'Enter a payment reference or UTR with 6 to 64 letters or numbers.' })
    const payment = { id: `PAY-${randomUUID().slice(0, 8).toUpperCase()}`, amount: Math.round(amount * 100) / 100, reference, provider, status: 'Pending verification', submittedAt: new Date().toISOString() }
    order.payments ||= []
    order.payments.unshift(payment)
    const emailJob = await emailPaymentStateChange(order, 'Bank transfer submitted', [
      ['Payment status', 'Awaiting agency verification'], ['Amount', formatINR(payment.amount)],
      ['Payment method', provider], ['Transfer reference', reference], ['Submitted at', emailTimestamp(payment.submittedAt)]
    ], `Your bank transfer for order ${order.id} was recorded. The agency will update your balance after confirming the funds.`)
    payment.emailStatus = emailJob.status
    persistPortalState()
    return json(res, 201, { payment, order: clientOrderForDashboard(order), emailStatus: emailJob.status })
  }
  if (req.method === 'DELETE' && url.pathname === '/api/profile') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !clientSessions.has(token)) return json(res, 401, { error: 'Client sign-in required.' })
    const profileId = clientSessions.get(token)
    const profile = [...profilesByGst.values()].find(item => item.id === profileId)
    if (!profile) return json(res, 404, { error: 'No customer profile is linked to this sign-in.' })
    const relatedOrders = orders.filter(order => order.profileId === profile.id)
    if (relatedOrders.some(order => isOrderPaymentEditLocked(order) || hasUnresolvedOnlineRefund(order))) return json(res, 423, { error: 'A fully paid order or unresolved online refund on this profile must be resolved before deletion.' })
    profile.updatedAt = new Date().toISOString()
    queueProfileUpdateEmail(profile, [['Profile status', 'Moved to the 30-day recovery bin at your request'], ['Active orders', relatedOrders.length]], null, {
      title: 'Customer profile deletion recorded', sectionTitle: 'Record update',
      introduction: 'Your request to delete this customer profile has been recorded. The profile and active orders can be restored by an administrator during the 30-day recovery period.',
      attachmentNote: 'If you did not request this change, contact Gouri Agency immediately.'
    })
    const trashItem = addToTrash({
      type: 'profile', label: profile.shopName || profile.gstNumber, profileId: profile.id,
      orderCount: relatedOrders.length, deletedBy: 'Client', reason: 'client request',
      payload: { profile, orders: relatedOrders }
    })
    deleteActiveProfile(profile)
    persistPortalState()
    return json(res, 200, { deleted: true, trash: trashMetadata(trashItem) })
  }
  if (req.method === 'PATCH' && url.pathname === '/api/profile') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const profileId = token ? clientSessions.get(token) : null
    const profile = profileId ? [...profilesByGst.values()].find(item => item.id === profileId) : null
    if (!profile) return json(res, 401, { error: 'Sign in with a registered customer account to update your profile.' })
    const body = await readJson(req, res)
    if (!body) return
    if (Object.hasOwn(body, 'gstNumber')) {
      return json(res, 403, { error: 'Clients cannot update the GST number.' })
    }
    if (profile.gstVerifiedAt) {
      const changedVerifiedIdentity = ['shopName', 'shopAddress'].some(field =>
        Object.hasOwn(body, field) && String(body[field] || '').trim() !== String(profile[field] || '').trim()
      )
      if (changedVerifiedIdentity) return json(res, 403, { error: 'This GST-verified shop name and address are locked. Contact an admin if they need correction.' })
    }
    const clientMayRenewBeforeExpiry = !profileFrozen(profile)
    if (Object.hasOwn(body, 'drugLicenseExpiresAt')) {
      if (!clientMayRenewBeforeExpiry) {
        return json(res, 403, { error: 'Only an admin can update a missing or expired drug license expiry date.' })
      }
      if (!validDateKey(body.drugLicenseExpiresAt) || body.drugLicenseExpiresAt < indiaDateKey()) {
        return json(res, 400, { error: 'Enter a valid drug license expiry date that is today or later.' })
      }
    }
    if (profileFrozen(profile)) {
      const frozenFields = ['shopName', 'businessType', 'ownerName', 'partnerOne', 'partnerTwo', 'email', 'mobile', 'shopAddress', 'pincode', 'city', 'state', 'country']
      const changedFrozenField = frozenFields.some(field => Object.hasOwn(body, field) && String(body[field] || '') !== String(profile[field] || ''))
      const attachments = body.attachments || {}
      if (changedFrozenField || attachments.ownerPhoto || attachments.gstCopy || attachments.signature) {
        return json(res, 423, { error: 'This profile is frozen until an admin records a valid future drug license expiry date. You may still update the drug license number and upload its current copy.' })
      }
    }
    const before = structuredClone(profile)
    const result = updateProfile(profile, body, {
      allowDrugLicense: true,
      allowExpiryDate: Object.hasOwn(body, 'drugLicenseExpiresAt') && clientMayRenewBeforeExpiry
    })
    if (result.error) return json(res, result.status || 400, { error: result.error })
    const changedFields = profileChangedFields(before, result.profile, body.attachments)
    const ledger = await refreshLatestLedger(profile)
    const emailJob = changedFields.length ? queueProfileUpdateEmail(profile, changedFields, ledger, { previousEmail: before.email }) : null
    persistPortalState()
    return json(res, 200, { profile: safeProfile(result.profile), emailStatus: emailJob?.status || null })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/messages') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const profileId = String(url.searchParams.get('profileId') || '')
    if (!profileId) return json(res, 400, { error: 'Choose a client profile to open its communication thread.' })
    const profile = [...profilesByGst.values()].find(item => item.id === profileId)
    if (!profile) return json(res, 404, { error: 'Customer profile not found.' })
    return json(res, 200, { messages: communicationThreadForProfile(profileId) })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/messages') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const body = await readJson(req, res)
    if (!body) return
    const profileId = typeof body.profileId === 'string' ? body.profileId : ''
    const profile = [...profilesByGst.values()].find(item => item.id === profileId)
    if (!profile) return json(res, 404, { error: 'Choose a registered client profile before sending a message.' })
    if (!emailAddressPattern.test(normalizeEmailAddress(profile.email))) return json(res, 409, { error: 'This profile does not have a valid registered email address.' })
    const fields = validateCommunicationPayload(body)
    if (fields.error) return json(res, 400, { error: fields.error })
    const message = queueCommunicationMessage({
      profile,
      senderRole: 'admin',
      senderName: 'Gouri Agency',
      senderEmail: emailSettings.fromAddress,
      to: profile.email,
      subject: fields.subject,
      body: fields.body,
      upload: fields.upload
    })
    return json(res, 201, { message })
  }
  const adminMessageAttachmentPath = /^\/api\/admin\/messages\/([a-f0-9-]{36})\/attachment$/.exec(url.pathname)
  if (req.method === 'GET' && adminMessageAttachmentPath) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const message = communicationMessages.find(item => item.id === adminMessageAttachmentPath[1])
    if (!message?.attachment) return json(res, 404, { error: 'Message attachment not found.' })
    return sendCommunicationAttachment(res, message)
  }
  if (req.method === 'GET' && url.pathname === '/api/orders') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    return json(res, 200, { orders: orders.map(orderForDashboard), profiles: [...profilesByGst.values()].map(dashboardProfile) })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/payment-settings') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    return json(res, 200, { bankTransferDetails: paymentSettings.bankTransfer, dueReminderSettings: paymentSettings.dueReminders, orderIntakeSettings: paymentSettings.orderIntake, promoCodeSettings: paymentSettings.promoCode })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/promo-code-settings') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    return json(res, 200, { promoCodeSettings: paymentSettings.promoCode })
  }
  if (req.method === 'PUT' && url.pathname === '/api/admin/promo-code-settings') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const body = await readJson(req, res)
    if (!body) return
    const promo = body.promoCodeSettings || {}
    const enabled = Boolean(promo.enabled)
    const code = typeof promo.code === 'string' ? promo.code.trim().toUpperCase() : ''
    const discountType = promo.discountType === 'fixed' ? 'fixed' : promo.discountType === 'percent' ? 'percent' : ''
    const discountValue = Number(promo.discountValue)
    const emoji = typeof promo.emoji === 'string' ? promo.emoji.trim().slice(0, 12) : ''
    const startsAt = typeof promo.startsAt === 'string' ? promo.startsAt.trim() : ''
    const endsAt = typeof promo.endsAt === 'string' ? promo.endsAt.trim() : ''
    const startTime = startsAt ? Date.parse(startsAt) : NaN
    const endTime = endsAt ? Date.parse(endsAt) : NaN
    if (Boolean(startsAt) !== Boolean(endsAt)) return json(res, 400, { error: 'Set both the offer start and end date/time, or leave both blank.' })
    if (startsAt && (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime)) return json(res, 400, { error: 'Enter a valid offer window and make the end date/time later than the start.' })
    if (enabled && !/^[A-Z0-9_-]{3,24}$/.test(code)) return json(res, 400, { error: 'Use a promo code with 3 to 24 letters, numbers, hyphens, or underscores.' })
    if (enabled && !discountType) return json(res, 400, { error: 'Choose a percentage or fixed-amount discount.' })
    if (enabled && (!Number.isFinite(discountValue) || discountValue <= 0 || (discountType === 'percent' && discountValue > 100) || (discountType === 'fixed' && discountValue > 1000000000))) return json(res, 400, { error: discountType === 'percent' ? 'Percentage discount must be greater than 0 and no more than 100.' : 'Enter a fixed discount greater than 0 and no more than ₹1,000,000,000.' })
    paymentSettings = normalizePaymentSettings({ ...paymentSettings, promoCode: { enabled, code, discountType: discountType || 'percent', discountValue: Number.isFinite(discountValue) && discountValue > 0 ? discountValue : 0, emoji: emoji || '🎉', startsAt, endsAt } })
    persistPortalState()
    return json(res, 200, { promoCodeSettings: paymentSettings.promoCode })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/order-intake-settings') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    return json(res, 200, { orderIntakeSettings: paymentSettings.orderIntake })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/email-settings') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    return json(res, 200, { emailSettings, allowedFromAddresses: [...EMAIL_ALLOWED_FROM_ADDRESSES].sort() })
  }
  if (req.method === 'PUT' && url.pathname === '/api/admin/email-settings') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const body = await readJson(req, res)
    if (!body) return
    const fromName = typeof body.fromName === 'string' ? body.fromName.trim() : ''
    const fromAddress = normalizeEmailAddress(body.fromAddress)
    if (!fromName || fromName.length > 80 || /[<>\r\n\x00-\x1f]/.test(fromName)) return json(res, 400, { error: 'Enter a sender name up to 80 characters without line breaks or angle brackets.' })
    if (!emailAddressPattern.test(fromAddress)) return json(res, 400, { error: 'Enter a valid sender email address.' })
    if (!EMAIL_ALLOWED_FROM_ADDRESSES.has(fromAddress)) return json(res, 400, { error: 'This sender is not authorized for the configured Gmail account. Add it as a Gmail Send mail as alias and to GMAIL_ALLOWED_FROM_ADDRESSES, then restart the server.' })
    if (!Array.isArray(body.ccEmails) || body.ccEmails.length > 20 || body.ccEmails.some(address => typeof address !== 'string' || !emailAddressPattern.test(normalizeEmailAddress(address)))) {
      return json(res, 400, { error: 'Enter up to 20 valid CC email addresses.' })
    }
    emailSettings = normalizeEmailSettings({ fromName, fromAddress, ccEmails: body.ccEmails })
    persistPortalState()
    return json(res, 200, { emailSettings, allowedFromAddresses: [...EMAIL_ALLOWED_FROM_ADDRESSES].sort() })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/access-settings') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    return json(res, 200, { adminLoginId: adminCredentials.email })
  }
  if (req.method === 'PUT' && url.pathname === '/api/admin/access-settings') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const body = await readJson(req, res)
    if (!body) return
    if (!verifyAdminPassword(body.currentPassword, adminCredentials)) return json(res, 401, { error: 'The current admin password is incorrect.' })
    const loginId = normalizeEmailAddress(body.loginId)
    if (!emailAddressPattern.test(loginId)) return json(res, 400, { error: 'Enter a valid admin email address.' })
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
    const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : ''
    const isChangingPassword = Boolean(newPassword || confirmPassword)
    if (isChangingPassword && (!newPassword || newPassword.length < 12 || newPassword.length > 128)) return json(res, 400, { error: 'A new admin password must be between 12 and 128 characters.' })
    if (isChangingPassword && newPassword !== confirmPassword) return json(res, 400, { error: 'The new password and confirmation do not match.' })
    adminCredentials = isChangingPassword
      ? createAdminCredentialRecord(loginId, newPassword)
      : { ...adminCredentials, email: loginId }
    for (const otherToken of adminSessions) if (otherToken !== token) adminSessions.delete(otherToken)
    persistPortalState()
    return json(res, 200, { adminLoginId: adminCredentials.email, otherSessionsSignedOut: true })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/home-slider') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    return json(res, 200, { homeSlider: homeSliderPayload() })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/notices') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    return json(res, 200, { notices })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/notices') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const body = await readJson(req, res)
    if (!body) return
    const title = typeof body.title === 'string' ? body.title.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim() : ''
    const message = typeof body.body === 'string' ? body.body.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim() : ''
    if (!title || title.length > 120) return json(res, 400, { error: 'Enter a notice heading up to 120 characters.' })
    if (!message || message.length > 15000) return json(res, 400, { error: 'Enter a notice message up to 15,000 characters.' })
    if (body.priority !== undefined && !['standard', 'high'].includes(body.priority)) return json(res, 400, { error: 'Choose a valid notice priority.' })
    if (notices.length >= 200) return json(res, 409, { error: 'The board has reached 200 notices. Delete an old notice before publishing another.' })
    const notice = { id: randomUUID(), title, body: message, priority: body.priority === 'high' ? 'high' : 'standard', createdAt: new Date().toISOString() }
    const previousNotices = [...notices]
    notices.unshift(notice)
    try { await persistPortalState() }
    catch {
      notices.splice(0, notices.length, ...previousNotices)
      return json(res, 503, { error: 'MongoDB Atlas could not save the notice. Please try again.' })
    }
    return json(res, 201, { notice, notices })
  }
  const adminNoticeDeleteMatch = /^\/api\/admin\/notices\/([a-f0-9-]{36})$/i.exec(url.pathname)
  if (req.method === 'DELETE' && adminNoticeDeleteMatch) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const noticeIndex = notices.findIndex(item => item.id === adminNoticeDeleteMatch[1].toLowerCase())
    if (noticeIndex < 0) return json(res, 404, { error: 'Notice not found. It may already have been deleted.' })
    const removedNotice = notices.splice(noticeIndex, 1)[0]
    try { await persistPortalState() }
    catch {
      notices.splice(noticeIndex, 0, removedNotice)
      return json(res, 503, { error: 'MongoDB Atlas could not delete the notice. Please try again.' })
    }
    return json(res, 200, { notice: removedNotice, notices })
  }
  if (req.method === 'PUT' && url.pathname === '/api/admin/home-slider') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const body = await readJson(req, res)
    if (!body) return
    const intervalSeconds = Number(body.intervalSeconds)
    if (typeof body.enabled !== 'boolean' || !Number.isInteger(intervalSeconds) || intervalSeconds < 3 || intervalSeconds > 120) {
      return json(res, 400, { error: 'Choose whether the home slider is enabled and set an interval from 3 to 120 seconds.' })
    }
    if (!Array.isArray(body.images) || body.images.length !== 6) return json(res, 400, { error: 'The home slider must contain six image slots.' })
    const nextImages = []
    const stagedFiles = []
    for (let index = 0; index < body.images.length; index++) {
      const image = body.images[index]
      if (image === null) { nextImages.push(null); continue }
      if (image && typeof image.id === 'string' && !Object.hasOwn(image, 'data')) {
        const existing = homeSlider.images[index]
        if (!existing || existing.id !== image.id) return json(res, 400, { error: `Home slider image ${index + 1} does not match the saved image in that slot.` })
        nextImages.push(existing)
        continue
      }
      if (!validUpload(image, ['image/jpeg', 'image/png'])) return json(res, 400, { error: `Slide ${index + 1} must be a valid JPG or PNG image.` })
      const base64 = image.data.slice(image.data.indexOf(',') + 1)
      const bytes = Buffer.from(base64, 'base64')
      if (bytes.length > MAX_HOME_SLIDER_IMAGE_BYTES) return json(res, 400, { error: `Slide ${index + 1} must be 2 MB or smaller.` })
      const type = image.type
      const extension = type === 'image/jpeg' ? 'jpg' : 'png'
      const id = randomUUID()
      const name = image.name.split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(0, 100) || `Home slide ${index + 1}.${extension}`
      const savedImage = { id, name, type }
      nextImages.push(savedImage)
      stagedFiles.push({ fileName: `home-slide-${id}`, bytes, id, name, type })
    }
    const previousHomeSlider = homeSlider
    try {
      for (const file of stagedFiles) await uploadGridFsBuffer(homeSliderAssetBucket, file.fileName, file.bytes, { kind: 'home-slider', assetId: file.id, name: file.name }, file.type)
      homeSlider = normalizeHomeSlider({ enabled: body.enabled, intervalSeconds, images: nextImages })
      await persistPortalState()
    } catch (error) {
      homeSlider = previousHomeSlider
      for (const file of stagedFiles) {
        const uploaded = await mongoDb.collection('home_slider_assets.files').findOne({ 'metadata.assetId': file.id }).catch(() => null)
        if (uploaded) await deleteGridFsFile(homeSliderAssetBucket, uploaded._id).catch(() => {})
      }
      return json(res, 503, { error: 'MongoDB Atlas could not save the home slider. Please try again.' })
    }
    const nextIds = new Set(homeSlider.images.filter(Boolean).map(image => image.id))
    for (const image of previousHomeSlider.images.filter(Boolean)) {
      if (nextIds.has(image.id)) continue
      const previousFile = await mongoDb.collection('home_slider_assets.files').findOne({ 'metadata.assetId': image.id })
      if (previousFile) await deleteGridFsFile(homeSliderAssetBucket, previousFile._id).catch(error => console.error('Could not remove an old MongoDB home slider image:', error.message))
    }
    return json(res, 200, { homeSlider: homeSliderPayload() })
  }
  if (req.method === 'PUT' && url.pathname === '/api/admin/due-reminder-settings') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const body = await readJson(req, res)
    if (!body) return
    const intervalDays = Number(body.intervalDays)
    if (typeof body.enabled !== 'boolean' || !Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 365) {
      return json(res, 400, { error: 'Choose whether reminders are enabled and set an interval from 1 to 365 days.' })
    }
    paymentSettings = normalizePaymentSettings({ ...paymentSettings, dueReminders: { enabled: body.enabled, intervalDays } })
    persistPortalState()
    return json(res, 200, { dueReminderSettings: paymentSettings.dueReminders })
  }
  if (req.method === 'PUT' && url.pathname === '/api/admin/order-intake-settings') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const body = await readJson(req, res)
    if (!body) return
    if (typeof body.enabled !== 'boolean' || typeof body.message !== 'string' || body.message.trim().length > 300) {
      return json(res, 400, { error: 'Choose whether order requests are open and keep the closed notice within 300 characters.' })
    }
    const previousSettings = paymentSettings
    paymentSettings = normalizePaymentSettings({ ...paymentSettings, orderIntake: { enabled: body.enabled, message: body.message } })
    try { await persistPortalState() }
    catch {
      paymentSettings = previousSettings
      return json(res, 503, { error: 'MongoDB Atlas could not save the order intake setting. Please try again.' })
    }
    return json(res, 200, { orderIntakeSettings: paymentSettings.orderIntake })
  }
  if (req.method === 'PUT' && url.pathname === '/api/admin/payment-settings') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const body = await readJson(req, res)
    if (!body) return
    const bank = body.bankTransferDetails || {}
    const required = ['accountName', 'bankName', 'accountNumber', 'ifscCode']
    if (required.some(field => typeof bank[field] !== 'string' || !bank[field].trim())) {
      return json(res, 400, { error: 'Enter the account holder, bank, account number, and IFSC code.' })
    }
    if (!/^[A-Za-z0-9 -]{6,30}$/.test(bank.accountNumber.trim())) return json(res, 400, { error: 'Enter a valid bank account number.' })
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(bank.ifscCode.trim())) return json(res, 400, { error: 'Enter a valid 11-character IFSC code.' })
    if (typeof bank.branch === 'string' && bank.branch.length > 100) return json(res, 400, { error: 'Branch name must be 100 characters or fewer.' })
    if (typeof bank.instructions === 'string' && bank.instructions.length > 500) return json(res, 400, { error: 'Transfer instructions must be 500 characters or fewer.' })
    paymentSettings = normalizePaymentSettings({ ...paymentSettings, bankTransfer: Object.fromEntries(Object.keys(blankBankTransferDetails).map(field => [field, String(bank[field] || '').trim()])) })
    persistPortalState()
    return json(res, 200, { bankTransferDetails: paymentSettings.bankTransfer })
  }
  if (req.method === 'POST' && /^\/api\/admin\/profiles\/[^/]+\/statement\/email$/.test(url.pathname)) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const statementPath = /^\/api\/admin\/profiles\/([^/]+)\/statement\/email$/.exec(url.pathname)
    const profileId = decodeURIComponent(statementPath[1])
    const profile = [...profilesByGst.values()].find(item => item.id === profileId)
    if (!profile) return json(res, 404, { error: 'Customer profile not found.' })
    const body = await readJson(req, res)
    if (!body) return
    const fromDate = body.fromDate
    const toDate = body.toDate
    if (!validStatementDate(fromDate) || !validStatementDate(toDate) || fromDate > toDate) {
      return json(res, 400, { error: 'Choose a valid statement start and end date.' })
    }
    try {
      const accountOrders = orders.filter(order => order.profileId === profile.id)
      const job = await queueStatementEmail(profile, accountOrders, fromDate, toDate)
      return json(res, 202, { emailStatus: job.status, to: profile.email, filename: job.attachments?.[0]?.filename || `${safeFileName(profile.shopName)}-statement.pdf` })
    } catch (error) {
      return json(res, 400, { error: error.message || 'Could not prepare the statement email.' })
    }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/admin/profiles/') && url.pathname.endsWith('/latest-ledger')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const profileId = decodeURIComponent(url.pathname.slice('/api/admin/profiles/'.length, -'/latest-ledger'.length))
    const profile = [...profilesByGst.values()].find(item => item.id === profileId)
    if (!profile) return json(res, 404, { error: 'Customer profile not found.' })
    return sendPdf(res, await ensureCurrentLedger(profile))
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/admin/orders/') && url.pathname.includes('/payments/') && url.pathname.endsWith('/receipt')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const receiptPath = /^\/api\/admin\/orders\/([^/]+)\/payments\/([^/]+)\/receipt$/.exec(url.pathname)
    if (!receiptPath) return json(res, 404, { error: 'Payment receipt not found.' })
    const order = orders.find(item => item.id === decodeURIComponent(receiptPath[1]))
    if (!order) return json(res, 404, { error: 'Order not found.' })
    const payment = (order.payments || []).find(item => item.id === decodeURIComponent(receiptPath[2]))
    if (!payment) return json(res, 404, { error: 'Payment record not found.' })
    return sendPaymentReceipt(res, order, payment)
  }
  if (req.method === 'GET' && url.pathname === '/api/trash') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    purgeExpiredTrash()
    return json(res, 200, { trash: trash.map(trashMetadata) })
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/trash/') && url.pathname.endsWith('/restore')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const trashId = decodeURIComponent(url.pathname.slice('/api/trash/'.length, -'/restore'.length))
    const item = trash.find(record => record.id === trashId)
    if (!item) return json(res, 404, { error: 'This trash item has expired or was already removed.' })
    if (Date.parse(item.expiresAt) <= Date.now()) {
      purgeExpiredTrash()
      return json(res, 410, { error: 'This item passed its 30-day recovery period.' })
    }
    if (item.type === 'profile') {
      const profile = item.payload.profile
      const gstKey = normalizeGst(profile.gstNumber)
      const duplicateProfile = profilesByGst.get(gstKey)
      if (duplicateProfile && duplicateProfile.id !== profile.id) return json(res, 409, { error: 'A different active profile now uses this GST number. Resolve that profile before restoring.' })
      if (orders.some(order => (item.payload.orders || []).some(savedOrder => savedOrder.id === order.id))) return json(res, 409, { error: 'One or more order IDs from this profile already exist. Resolve those records before restoring.' })
      profilesByGst.set(gstKey, profile)
      orders.unshift(...(item.payload.orders || []))
      profile.orderIds = (item.payload.orders || []).map(order => order.id)
      profile.updatedAt = new Date().toISOString()
      await refreshLatestLedger(profile)
      queueProfileUpdateEmail(profile, [['Profile status', 'Restored from the admin recovery bin'], ['Restored at', emailTimestamp(profile.updatedAt)]], null, {
        title: 'Customer profile restored', sectionTitle: 'Record update',
        introduction: 'Your customer profile and saved active orders have been restored to the Gouri Agency portal.',
        attachmentNote: 'Sign in to your client portal to review the restored profile and order records.'
      })
      trash.splice(trash.indexOf(item), 1)
      persistPortalState()
      return json(res, 200, { restored: true, profile: safeProfile(profile), orders: item.payload.orders || [], deletedIds: [item.id] })
    }
    const profile = [...profilesByGst.values()].find(record => record.id === item.profileId)
    if (!profile) return json(res, 409, { error: 'Restore the customer profile before restoring this order.' })
    if (orders.some(order => order.id === item.payload.id)) return json(res, 409, { error: 'This order ID already exists in the active records.' })
    const order = item.payload
    orders.unshift(order)
    profile.orderIds = [order.id, ...(profile.orderIds || []).filter(id => id !== order.id)]
    profile.updatedAt = new Date().toISOString()
    order.updatedAt = new Date().toISOString()
    const ledger = await refreshLatestLedger(profile, order)
    const orderEmail = queueOrderUpdateEmail(profile, order, [['Record status', 'Restored from the admin recovery bin'], ['Restored at', emailTimestamp(order.updatedAt)]], ledger, {
      introduction: `Order ${order.id} has been restored to the active order list.`,
      attachmentNote: `The latest agreement PDF for restored order ${order.id} is attached.`
    })
    order.emailStatus = orderEmail.status
    trash.splice(trash.indexOf(item), 1)
    persistPortalState()
    return json(res, 200, { restored: true, order, profile: safeProfile(profile), deletedIds: [item.id] })
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/trash/')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const trashId = decodeURIComponent(url.pathname.slice('/api/trash/'.length))
    const item = trash.find(record => record.id === trashId)
    if (!item) return json(res, 404, { error: 'This trash item has expired or was already removed.' })
    if (item.type === 'profile' && item.payload?.profile) {
      const profile = item.payload.profile
      profile.updatedAt = new Date().toISOString()
      queueProfileUpdateEmail(profile, [['Profile status', 'Permanently deleted from the recovery bin'], ['Deleted at', emailTimestamp(profile.updatedAt)]], null, {
        title: 'Customer profile permanently deleted', sectionTitle: 'Record update',
        introduction: 'An administrator permanently deleted this customer profile after the recovery period or by direct request. This profile can no longer be restored.',
        attachmentNote: 'Contact Gouri Agency if you need assistance with a new registration.'
      })
    } else if (item.type === 'order' && item.payload) {
      const order = item.payload
      order.updatedAt = new Date().toISOString()
      const profile = [...profilesByGst.values()].find(record => record.id === order.profileId)
      queueOrderUpdateEmail(profile, order, [['Record status', 'Permanently deleted from the recovery bin'], ['Deleted at', emailTimestamp(order.updatedAt)]], null, {
        introduction: `An administrator permanently deleted order ${order.id} from the recovery bin. This order can no longer be restored.`,
        attachmentNote: 'Contact Gouri Agency if you need assistance with this order record.'
      })
    }
    const deletedIds = item.type === 'profile'
      ? trash.filter(record => record.id === item.id || (record.type === 'order' && record.profileId === item.profileId)).map(record => record.id)
      : [item.id]
    for (let index = trash.length - 1; index >= 0; index--) if (deletedIds.includes(trash[index].id)) trash.splice(index, 1)
    persistPortalState()
    return json(res, 200, { permanentlyDeleted: true, deletedIds })
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/orders/')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const orderId = decodeURIComponent(url.pathname.slice('/api/orders/'.length))
    const order = orders.find(item => item.id === orderId)
    if (!order) return json(res, 404, { error: 'Order not found.' })
    if (hasUnresolvedOnlineRefund(order)) return json(res, 423, { error: 'Resolve or retry this order’s online refund before deleting the order.' })
    if (isOrderPaymentEditLocked(order)) return json(res, 423, { error: `This fully paid order is locked until ${getOrderPaymentEditLockUntil(order)}.`, paymentEditLockedUntil: getOrderPaymentEditLockUntil(order) })
    const profile = [...profilesByGst.values()].find(item => item.id === order.profileId)
    order.updatedAt = new Date().toISOString()
    const orderEmail = queueOrderUpdateEmail(profile, order, [['Record status', 'Moved to the 30-day admin recovery bin'], ['Updated at', emailTimestamp(order.updatedAt)]], null, {
      introduction: `An administrator moved order ${order.id} to the recovery bin. It can be restored for 30 days before permanent deletion.`,
      attachmentNote: 'Contact Gouri Agency if you believe this order move was made in error.'
    })
    order.emailStatus = orderEmail.status
    const trashItem = addToTrash({ type: 'order', label: `${order.id} · ${order.shopName}`, profileId: order.profileId, orderId: order.id, deletedBy: 'Admin', reason: 'admin deleted order', payload: order })
    orders.splice(orders.indexOf(order), 1)
    if (profile) {
      profile.orderIds = (profile.orderIds || []).filter(id => id !== order.id)
      profile.updatedAt = new Date().toISOString()
      await refreshLatestLedger(profile)
    }
    persistPortalState()
    return json(res, 200, { deleted: true, orderId: order.id, profile: safeProfile(profile), trash: trashMetadata(trashItem) })
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/profiles/')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const profileId = decodeURIComponent(url.pathname.slice('/api/profiles/'.length))
    const profile = [...profilesByGst.values()].find(item => item.id === profileId)
    if (!profile) return json(res, 404, { error: 'Customer profile not found.' })
    const relatedOrders = orders.filter(order => order.profileId === profile.id)
    if (relatedOrders.some(order => isOrderPaymentEditLocked(order) || hasUnresolvedOnlineRefund(order))) return json(res, 423, { error: 'A fully paid order or unresolved online refund on this profile must be resolved before deletion.' })
    profile.updatedAt = new Date().toISOString()
    queueProfileUpdateEmail(profile, [['Profile status', 'Moved to the 30-day admin recovery bin'], ['Active orders', relatedOrders.length]], null, {
      title: 'Customer profile moved to recovery', sectionTitle: 'Record update',
      introduction: 'An administrator moved your customer profile and active orders to the recovery bin. The records are scheduled for permanent deletion after 30 days unless restored.',
      attachmentNote: 'Contact Gouri Agency if you believe this profile move was made in error.'
    })
    const trashItem = addToTrash({ type: 'profile', label: profile.shopName || profile.gstNumber, profileId: profile.id, orderCount: relatedOrders.length, deletedBy: 'Admin', reason: 'admin deleted profile', payload: { profile, orders: relatedOrders } })
    deleteActiveProfile(profile)
    persistPortalState()
    return json(res, 200, { deleted: true, profileId: profile.id, trash: trashMetadata(trashItem) })
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/orders/') && url.pathname.endsWith('/refund-retry')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const refundPath = /^\/api\/orders\/([^/]+)\/payments\/([^/]+)\/refund-retry$/.exec(url.pathname)
    if (!refundPath) return json(res, 400, { error: 'Refund record was not found.' })
    const order = orders.find(item => item.id === decodeURIComponent(refundPath[1]))
    if (!order) return json(res, 404, { error: 'Order not found.' })
    const payment = (order.payments || []).find(item => item.id === decodeURIComponent(refundPath[2]))
    if (!payment) return json(res, 404, { error: 'Payment record not found.' })
    if (order.status === 'Cancelled' && payment.provider === 'Account credit' && payment.refundStatus === 'failed') {
      const sourceOrder = orders.find(item => item.id === payment.sourceOrderId && item.profileId === order.profileId)
      const sourcePayment = sourceOrder?.payments?.find(item => item.id === payment.sourcePaymentId)
      if (!sourceOrder || !sourcePayment || !isGatewayPayment(sourcePayment) || sourcePayment.status !== 'Paid') return json(res, 409, { error: 'The source gateway payment is unavailable for an automatic retry.' })
      const pendingForOrder = (sourcePayment.refunds || []).filter(refund => refund.allocationOrderId === order.id && ['pending', 'initiating'].includes(refund.status)).reduce((sum, refund) => sum + Number(refund.amount || 0), 0)
      const retryAmount = Math.max(0, Number(payment.amountApplied ?? payment.amount ?? 0) - Number(payment.amountRefunded || 0) - pendingForOrder)
      if (retryAmount < 0.01) return json(res, 409, { error: 'No remaining carry-forward amount is available to refund.' })
      try {
        await initiateOnlineRefund(sourceOrder, sourcePayment, { amount: retryAmount, allocationOrderId: order.id, reason: `Admin retry for cancelled order ${order.id}`, suffix: `credit-retry-${order.id}-${Date.now()}` })
      } catch (error) {
        await markRazorpayRefundFailed(sourceOrder, sourcePayment, error, { notify: true })
        return json(res, 502, { error: payment.refundFailureReason || error.message, order: orderForDashboard(order), payment })
      }
      const profile = [...profilesByGst.values()].find(item => item.id === order.profileId)
      if (profile) await refreshLatestLedger(profile, order)
      await emailPaymentStateChange(order, 'Refund retry submitted', [['Payment provider', payment.originalProvider || 'Payment gateway'], ['Source order', payment.sourceOrderId], ['Refund status', payment.refundStatus], ['Refund amount', formatINR(retryAmount)]], `The agency retried the carry-forward refund for cancelled order ${order.id}.`)
      persistPortalState()
      return json(res, 200, { order: orderForDashboard(order), payment })
    }
    if (order.status !== 'Cancelled' || !isGatewayPayment(payment) || payment.status !== 'Paid' || payment.refundStatus !== 'failed') {
      return json(res, 409, { error: 'Only a failed automatic refund on a cancelled online payment can be retried.' })
    }
    try {
      await initiateOnlineRefund(order, payment, { reason: `Admin retry for cancelled order ${order.id}`, suffix: `retry-${Date.now()}` })
    } catch (error) {
      await markRazorpayRefundFailed(order, payment, error, { notify: true })
      return json(res, 502, { error: payment.refundFailureReason, order: orderForDashboard(order), payment })
    }
    await emailPaymentStateChange(order, 'Refund retry submitted', [['Payment provider', gatewayDisplayName(payment)], ['Payment reference', payment.razorpayPaymentId || payment.cashfreePaymentId], ['Refund status', payment.refundStatus], ['Refunded amount', formatINR(payment.amountRefunded || 0)]], `The agency retried the ${gatewayDisplayName(payment)} refund for order ${order.id}. The updated status is listed below.`)
    return json(res, 200, { order: orderForDashboard(order), payment })
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/orders/') && url.pathname.includes('/payments/')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const body = await readJson(req, res)
    if (!body) return
    const paymentPath = /^\/api\/orders\/([^/]+)\/payments\/([^/]+)$/.exec(url.pathname)
    if (!paymentPath || !['Verified', 'Rejected'].includes(body.status)) return json(res, 400, { error: 'Choose Verified or Rejected for this payment.' })
    const orderId = decodeURIComponent(paymentPath[1])
    const paymentId = decodeURIComponent(paymentPath[2])
    const order = orders.find(item => item.id === orderId)
    if (!order) return json(res, 404, { error: 'Order not found.' })
    if (order.status === 'Cancelled') return json(res, 409, { error: 'Cancelled orders are read-only. Payment and refund history remains available.' })
    if (isOrderPaymentEditLocked(order)) return json(res, 423, { error: `This fully paid order is locked until ${getOrderPaymentEditLockUntil(order)}.`, paymentEditLockedUntil: getOrderPaymentEditLockUntil(order) })
    const payment = (order.payments || []).find(item => item.id === paymentId)
    if (!payment) return json(res, 404, { error: 'Payment record not found.' })
    if (payment.status !== 'Pending verification') return json(res, 400, { error: 'This payment has already been reviewed.' })
    if (body.status === 'Verified') {
      payment.reviewedAt = new Date().toISOString()
      const finalized = await finalizeConfirmedPayment(order, payment, { status: 'Verified', reference: payment.reference })
      return json(res, 200, { order: finalized.order, payment: finalized.payment, emailStatus: finalized.payment.emailStatus || 'needs_configuration' })
    }
    payment.status = body.status
    payment.reviewedAt = new Date().toISOString()
    const emailJob = await emailPaymentStateChange(order, 'Bank transfer not received', [
      ['Payment status', 'Not received'], ['Amount', formatINR(payment.amount)],
      ['Payment method', payment.provider], ['Transfer reference', payment.reference], ['Reviewed at', emailTimestamp(payment.reviewedAt)]
    ], `The agency could not confirm the bank transfer submitted for order ${order.id}. The outstanding balance remains unchanged.`)
    payment.emailStatus = emailJob.status
    persistPortalState()
    return json(res, 200, { order, payment, emailStatus: emailJob.status })
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/orders/')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const body = await readJson(req, res)
    if (!body) return
    const orderId = decodeURIComponent(url.pathname.slice('/api/orders/'.length))
    const order = orders.find(item => item.id === orderId)
    if (!order) return json(res, 404, { error: 'Project request not found.' })
    if (order.status === 'Cancelled') return json(res, 409, { error: 'Cancelled orders are read-only. Payment and refund history remains available.' })
    if (isOrderPaymentEditLocked(order)) return json(res, 423, { error: `This fully paid order is locked until ${getOrderPaymentEditLockUntil(order)}.`, paymentEditLockedUntil: getOrderPaymentEditLockUntil(order) })
    const hasStatus = Object.hasOwn(body, 'status')
    const hasAmountDue = Object.hasOwn(body, 'amountDue')
    const hasCostAmount = Object.hasOwn(body, 'costAmount')
    if (!hasStatus && !hasAmountDue && !hasCostAmount) return json(res, 400, { error: 'Provide an order status, due amount, or internal cost to update.' })
    if (hasStatus && !statusTransitions[order.status]?.includes(body.status)) {
      return json(res, 400, { error: 'This order cannot move to that status.' })
    }
    if (hasStatus && body.status === 'Rejected') {
      const hasUnresolvedPayment = Number(order.amountPaid || 0) > 0 || (order.payments || []).some(payment =>
        ['Paid', 'Verified', 'Pending verification'].includes(payment.status) ||
        (['Awaiting Razorpay payment', 'Awaiting Cashfree payment'].includes(payment.status) && Date.parse(payment.expiresAt) > Date.now())
      )
      if (hasUnresolvedPayment) return json(res, 409, { error: 'This order has payment activity. Resolve or reconcile its payments before rejecting and deleting the order.' })
      const profile = [...profilesByGst.values()].find(item => item.id === order.profileId)
      order.status = 'Rejected'
      order.updatedAt = new Date().toISOString()
      const emailJob = queueOrderUpdateEmail(profile, order, [['Order status', 'Rejected'], ['Decision', 'Order request rejected and removed from the active order list.']], null)
      order.emailStatus = emailJob.status
      const trashItem = addToTrash({ type: 'order', label: `${order.id} · ${order.shopName}`, profileId: order.profileId, orderId: order.id, deletedBy: 'Admin', reason: 'rejected order', payload: order })
      orders.splice(orders.indexOf(order), 1)
      if (profile) {
        profile.orderIds = (profile.orderIds || []).filter(id => id !== order.id)
        profile.updatedAt = new Date().toISOString()
        await refreshLatestLedger(profile)
      }
      persistPortalState()
      return json(res, 200, { deleted: true, orderId: order.id, profile: safeProfile(profile), trash: trashMetadata(trashItem) })
    }
    const amountDue = Number(body.amountDue)
    if (hasAmountDue && (!Number.isFinite(amountDue) || amountDue < 0 || amountDue > 1000000000)) {
      return json(res, 400, { error: 'Enter a due amount between ₹0 and ₹1,000,000,000.' })
    }
    const costAmount = body.costAmount === null ? null : Number(body.costAmount)
    if (hasCostAmount && costAmount !== null && (!Number.isFinite(costAmount) || costAmount < 0 || costAmount > 1000000000)) {
      return json(res, 400, { error: 'Enter an internal order cost from ₹0 to ₹1,000,000,000, or leave it blank.' })
    }
    const oldStatus = order.status
    const oldDue = Number(order.amountDue || 0)
    const changedFields = []
    if (hasStatus) {
      order.status = body.status
      if (body.status === 'Approved') order.approvedAt ||= new Date().toISOString()
      if (body.status !== oldStatus) changedFields.push(['Order status', `${oldStatus} → ${body.status}`])
    }
    if (hasAmountDue) {
      order.amountDue = Math.round(amountDue * 100) / 100
      if (order.amountDue !== oldDue) order.amountDueUpdatedAt = new Date().toISOString()
      if (order.amountDue !== oldDue) changedFields.push(['Order due total', `${formatINR(oldDue)} changed to ${formatINR(order.amountDue)}`])
      if (order.amountDue !== oldDue && order.promoApplied) {
        changedFields.push(['Promo discount', `${order.promoApplied.code} discount cleared because the agency updated the order due.`])
        delete order.promoApplied
        delete order.amountDueBeforePromo
      }
      if (order.amountDue > 0 && Number(order.amountPaid || 0) >= order.amountDue) {
        order.fullyPaidAt = new Date().toISOString()
        order.paymentEditLockedUntil = new Date(Date.now() + DAY_MS).toISOString()
      }
    }
    if (hasCostAmount) {
      if (costAmount === null) delete order.costAmount
      else order.costAmount = Math.round(costAmount * 100) / 100
    }
    order.updatedAt = new Date().toISOString()
    const profile = [...profilesByGst.values()].find(item => item.id === order.profileId)
    const ledger = profile ? await refreshLatestLedger(profile, order) : null
    const emailJob = changedFields.length ? queueOrderUpdateEmail(profile, order, changedFields, ledger) : null
    if (emailJob) order.emailStatus = emailJob.status
    persistPortalState()
    return json(res, 200, { order, emailStatus: emailJob?.status || null })
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/profiles/')) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !adminSessions.has(token)) return json(res, 401, { error: 'Admin sign-in required.' })
    const body = await readJson(req, res)
    if (!body) return
    const profileId = decodeURIComponent(url.pathname.slice('/api/profiles/'.length))
    const profile = [...profilesByGst.values()].find(item => item.id === profileId)
    if (!profile) return json(res, 404, { error: 'Customer profile not found.' })
    const before = structuredClone(profile)
    const result = updateProfile(profile, body, { allowProtectedFields: true })
    if (result.error) return json(res, result.status || 400, { error: result.error })
    const changedFields = profileChangedFields(before, result.profile, body.attachments)
    const ledger = await refreshLatestLedger(profile)
    const emailJob = changedFields.length ? queueProfileUpdateEmail(profile, changedFields, ledger, { previousEmail: before.email }) : null
    persistPortalState()
    return json(res, 200, { profile: safeProfile(result.profile), emailStatus: emailJob?.status || null })
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (token) { adminSessions.delete(token); clientSessions.delete(token) }
    return json(res, 200, { ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/api/orders') {
    const data = await readJson(req, res)
    if (!data) return
    const suppliedToken = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const isAdminSubmission = Boolean(suppliedToken && adminSessions.has(suppliedToken))
    const clientToken = suppliedToken && clientSessions.has(suppliedToken) ? suppliedToken : null
    if (suppliedToken && !isAdminSubmission && !clientToken) return json(res, 401, { error: 'Sign-in expired. Sign in again to submit this order.' })
    if (!paymentSettings.orderIntake.enabled) return json(res, 423, { error: paymentSettings.orderIntake.message, orderIntakeClosed: true })
    const clientProfileId = clientToken ? clientSessions.get(clientToken) : null
    const signedInProfile = clientProfileId ? [...profilesByGst.values()].find(item => item.id === clientProfileId) : null
    const existingProfileForOrder = signedInProfile || profilesByGst.get(normalizeGst(data.gstNumber)) || null
    const requiredFields = ['email', 'mobile', 'shopName', 'shopAddress', 'pincode', 'city', 'state', 'country', 'gstNumber', 'drugLicenseNumber']
    if (requiredFields.some(field => typeof data[field] !== 'string' || !data[field].trim())) {
      return json(res, 400, { error: 'Complete the email, mobile, and shop details.' })
    }
    if (!/^\d{6}$/.test(data.pincode.trim())) return json(res, 400, { error: 'Enter a valid six-digit PIN code.' })
    if (data.shopAddress.trim().length > 300 || ['city', 'state', 'country'].some(field => data[field].trim().length > 100)) return json(res, 400, { error: 'Shop address must be 300 characters or fewer; city, state, and country must be 100 characters or fewer.' })
    const gstVerification = data.gstVerificationProof ? readGstVerificationProof(data.gstVerificationProof) : null
    if (data.gstVerificationProof && (
      !gstVerification || gstVerification.gstin !== normalizeGst(data.gstNumber) ||
      gstVerification.registeredName !== String(data.shopName).trim() ||
      gstVerification.address !== String(data.shopAddress).trim() ||
      (gstVerification.pincode && gstVerification.pincode !== data.pincode.trim()) ||
      (gstVerification.city && gstVerification.city !== data.city.trim()) ||
      (gstVerification.state && gstVerification.state !== data.state.trim()) ||
      (gstVerification.country && gstVerification.country !== data.country.trim())
    )) {
      return json(res, 400, { error: 'GST verification has expired or the verified shop details changed. Check the GSTIN again, or continue with manual details if verification is unavailable.' })
    }
    if (signedInProfile?.gstVerifiedAt && (
      String(data.shopName).trim() !== String(signedInProfile.shopName).trim() ||
      String(data.shopAddress).trim() !== String(signedInProfile.shopAddress).trim()
    )) {
      return json(res, 403, { error: 'This GST-verified shop name and address are locked. Contact an admin if they need correction.' })
    }
    if (signedInProfile && normalizeGst(data.gstNumber) !== normalizeGst(signedInProfile.gstNumber)) {
      return json(res, 403, { error: 'Clients cannot update the GST number. Contact an admin if this needs correction.' })
    }
    if (signedInProfile && data.drugLicenseNumber.trim().toUpperCase() !== signedInProfile.drugLicenseNumber.trim().toUpperCase()) {
      return json(res, 403, { error: 'Clients cannot update the drug license number. Contact an admin if this needs correction.' })
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return json(res, 400, { error: 'Enter a valid email address.' })
    if (!/^\+?[0-9\s()-]+$/.test(data.mobile) || !/^\d{10,15}$/.test(data.mobile.replace(/\D/g, ''))) {
      return json(res, 400, { error: 'Enter a valid mobile number with 10 to 15 digits.' })
    }
    if (signedInProfile) {
      if (!validDateKey(signedInProfile.drugLicenseExpiresAt)) {
        return json(res, 423, { error: 'Your profile is frozen because its drug license expiry date is not recorded. Ask an admin to update it before placing an order.' })
      }
      if (data.drugLicenseExpiresAt !== signedInProfile.drugLicenseExpiresAt) {
        return json(res, 403, { error: 'Only an admin can update the drug license expiry date on a registered profile.' })
      }
    } else if (!validDateKey(data.drugLicenseExpiresAt)) {
      return json(res, 400, { error: 'Enter a valid drug license expiry date.' })
    }
    if (!['Sole proprietorship', 'Partnership'].includes(data.businessType)) return json(res, 400, { error: 'Choose a valid business type.' })
    if (data.businessType === 'Sole proprietorship' && (typeof data.ownerName !== 'string' || !data.ownerName.trim())) {
      return json(res, 400, { error: 'Enter the shop owner name.' })
    }
    if (data.businessType === 'Partnership' && (
      typeof data.partnerOne !== 'string' || !data.partnerOne.trim() ||
      typeof data.partnerTwo !== 'string' || !data.partnerTwo.trim()
    )) {
      return json(res, 400, { error: 'Enter the names of both partners.' })
    }
    const selectedSignatory = typeof data.authorizedSignatoryName === 'string' ? data.authorizedSignatoryName.trim() : ''
    if (data.businessType === 'Partnership' && ![data.partnerOne.trim(), data.partnerTwo.trim()].includes(selectedSignatory)) {
      return json(res, 400, { error: 'Choose which partner is signing this order.' })
    }
    if (data.declarationAccepted !== true) {
      return json(res, 400, { error: 'Accept the pre-order declaration before submitting this medicine order.' })
    }
    if (!Array.isArray(data.items) || data.items.length === 0 || data.items.length > 100 || data.items.some(item =>
      !item || typeof item.name !== 'string' || !item.name.trim() || normalizeOrderQuantity(item.quantity) === null
    )) {
      return json(res, 400, { error: 'Add each medicine with a valid name and quantity using letters, numbers, spaces, dots, slashes, or hyphens (up to 60 characters).' })
    }
    const suppliedAttachments = data.attachments || {}
    const attachments = {
      profilePhoto: suppliedAttachments.profilePhoto || existingProfileForOrder?.attachments?.ownerPhoto || existingProfileForOrder?.attachments?.profilePhoto || null,
      drugLicense: suppliedAttachments.drugLicense || existingProfileForOrder?.attachments?.drugLicense || null,
      gstCopy: suppliedAttachments.gstCopy || existingProfileForOrder?.attachments?.gstCopy || null,
      signature: suppliedAttachments.signature || existingProfileForOrder?.attachments?.signature || null
    }
    if (data.businessType === 'Partnership') {
      const savedDocumentsMatch = existingProfileForOrder?.authorizedSignatoryName === selectedSignatory
        && Boolean(existingProfileForOrder?.attachments?.ownerPhoto && existingProfileForOrder?.attachments?.signature)
      const freshDocumentsProvided = Boolean(suppliedAttachments.profilePhoto && suppliedAttachments.signature)
      if (String(data.partnerDocumentSignatory || '').trim() !== selectedSignatory || (!savedDocumentsMatch && !freshDocumentsProvided)) {
        return json(res, 400, { error: 'Upload the selected signing partner’s photo and signature before placing this order.' })
      }
    }
    if (!validUpload(attachments.drugLicense, ['application/pdf', 'image/jpeg'])) {
      return json(res, 400, { error: 'Upload a valid drug license PDF or JPG (up to 5 MB).' })
    }
    if (attachments.profilePhoto && !validUpload(attachments.profilePhoto, ['image/jpeg', 'image/png'])) {
      return json(res, 400, { error: 'Upload a valid profile photo JPG or PNG (up to 5 MB).' })
    }
    if (attachments.gstCopy && !validUpload(attachments.gstCopy, ['application/pdf', 'image/jpeg'])) {
      return json(res, 400, { error: 'Upload a valid GST copy PDF or JPG (up to 5 MB).' })
    }
    if (!validUpload(attachments.signature, ['image/png'])) {
      return json(res, 400, { error: 'Upload a required signature image with a clear signature on a light background.' })
    }
    const now = new Date().toISOString()
    const gstKey = normalizeGst(data.gstNumber)
    let profile = profilesByGst.get(gstKey)
    if (!signedInProfile && !isAdminSubmission && profile) {
      return json(res, 403, { error: 'This GST number is already linked to a customer profile. Sign in with its registered email, phone, or GST number.' })
    }
    const submittedExpiryDate = signedInProfile ? signedInProfile.drugLicenseExpiresAt : data.drugLicenseExpiresAt
    if (drugLicenseExpired(submittedExpiryDate)) {
      const recipient = signedInProfile?.email || data.email.trim()
      const customerName = signedInProfile?.ownerName || signedInProfile?.shopName || data.ownerName?.trim() || data.shopName.trim()
      const emailJob = queueExpiredDrugLicenseEmail({
        email: recipient, customerName, shopName: signedInProfile?.shopName || data.shopName.trim(),
        gstNumber: signedInProfile?.gstNumber || data.gstNumber, expiryDate: submittedExpiryDate
      })
      return json(res, 422, {
        error: `The drug license expired on ${submittedExpiryDate}. This request was rejected. Contact Gouri Agency to update the profile expiry date before placing an order.`,
        emailStatus: emailJob.status
      })
    }
    if (!profile) {
      profile = {
        id: `GAP-${nextProfileId++}`,
        gstNumber: gstKey,
        gstVerifiedAt: gstVerification ? new Date(gstVerification.issuedAt).toISOString() : null,
        drugLicenseExpiresAt: submittedExpiryDate,
        orderIds: [],
        createdAt: now
      }
      profilesByGst.set(gstKey, profile)
    }
    if (clientToken && !clientProfileId) clientSessions.set(clientToken, profile.id)
    Object.assign(profile, {
      shopName: data.shopName.trim(),
      businessType: data.businessType,
      ownerName: data.businessType === 'Sole proprietorship' ? data.ownerName.trim() : '',
      partnerOne: data.businessType === 'Partnership' ? data.partnerOne.trim() : '',
      partnerTwo: data.businessType === 'Partnership' ? data.partnerTwo.trim() : '',
      authorizedSignatoryName: data.businessType === 'Partnership' ? selectedSignatory : data.ownerName.trim(),
      email: data.email.trim(),
      mobile: data.mobile.trim(),
      shopAddress: data.shopAddress.trim(),
      pincode: data.pincode.trim(),
      city: data.city.trim(),
      state: data.state.trim(),
      country: data.country.trim(),
      drugLicenseNumber: profile.drugLicenseNumber || data.drugLicenseNumber.trim(),
      drugLicenseExpiresAt: isAdminSubmission ? data.drugLicenseExpiresAt : (profile.drugLicenseExpiresAt || submittedExpiryDate),
      updatedAt: now,
      attachments: {
        ownerPhoto: attachments.profilePhoto || profile.attachments?.ownerPhoto || null,
        drugLicense: profile.attachments?.drugLicense || attachments.drugLicense,
        gstCopy: attachments.gstCopy || profile.attachments?.gstCopy || null,
        signature: attachments.signature
      }
    })
    const order = {
      id: createOrderId(),
      profileId: profile.id,
      ownerName: data.businessType === 'Sole proprietorship' ? data.ownerName.trim() : '',
      email: data.email.trim(),
      mobile: data.mobile.trim(),
      shopName: data.shopName.trim(),
      businessType: data.businessType,
      partnerOne: data.businessType === 'Partnership' ? data.partnerOne.trim() : '',
      partnerTwo: data.businessType === 'Partnership' ? data.partnerTwo.trim() : '',
      shopAddress: data.shopAddress.trim(),
      pincode: data.pincode.trim(),
      city: data.city.trim(),
      state: data.state.trim(),
      country: data.country.trim(),
      gstNumber: data.gstNumber.trim(),
      gstVerifiedAt: gstVerification ? new Date(gstVerification.issuedAt).toISOString() : (profile.gstVerifiedAt || null),
      drugLicenseNumber: data.drugLicenseNumber.trim(),
      drugLicenseExpiresAt: profile.drugLicenseExpiresAt,
      items: data.items.map(item => ({ name: item.name.trim(), quantity: normalizeOrderQuantity(item.quantity) })),
      remarks: typeof data.remarks === 'string' ? data.remarks.trim() : '',
      attachments: {
        profilePhoto: attachments.profilePhoto || null,
        drugLicense: attachments.drugLicense,
        gstCopy: attachments.gstCopy || null,
        signature: attachments.signature
      },
      status: 'In progress',
      amountDue: 0,
      amountPaid: 0,
      payments: [],
      declarationAccepted: true,
      declarationAcceptedAt: now,
      date: now
    }
    profile.orderIds.unshift(order.id)
    orders.unshift(order)
    const latestLedgerPdf = await refreshLatestLedger(profile, order)
    const emailJob = queueOrderLedgerEmail(profile, order, latestLedgerPdf)
    order.emailStatus = emailJob.status
    persistPortalState()
    return json(res, 201, { order, profile: safeProfile(profile), latestLedgerPdf, emailStatus: emailJob.status })
  }
  if (!url.pathname.startsWith('/api') && ['GET', 'HEAD'].includes(req.method) && existsSync(resolve(DIST_DIRECTORY, 'index.html'))) {
    let requestPath
    try { requestPath = decodeURIComponent(url.pathname) }
    catch { return json(res, 400, { error: 'Invalid request path.' }) }
    const candidate = resolve(DIST_DIRECTORY, `.${requestPath}`)
    if (candidate !== DIST_DIRECTORY && !candidate.startsWith(`${DIST_DIRECTORY}${sep}`)) return json(res, 404, { error: 'Not found' })
    let filePath = candidate
    try {
      if (!statSync(filePath).isFile()) filePath = resolve(DIST_DIRECTORY, 'index.html')
    } catch {
      if (extname(requestPath)) return json(res, 404, { error: 'Not found' })
      filePath = resolve(DIST_DIRECTORY, 'index.html')
    }
    const fileInfo = statSync(filePath)
    const extension = extname(filePath).toLowerCase()
    const isHashedAsset = requestPath.startsWith('/assets/')
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream',
      'Content-Length': fileInfo.size,
      'Cache-Control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    })
    if (req.method === 'HEAD') return res.end()
    return createReadStream(filePath).pipe(res)
  }
  return json(res, 404, { error: 'Not found' })
})
await mongoDb.collection('home_slider_assets.files').createIndex({ 'metadata.assetId': 1 }, { unique: true, partialFilterExpression: { 'metadata.kind': 'home-slider' } })
await migrateLegacyHomeSliderAssets()
if (hasLegacyStateToImport || !currentPortalSnapshotId || adminCredentialsMigrated) await persistPortalState()
purgeExpiredTrash()
await persistenceTail
const trashSweep = setInterval(() => {
  refreshPortalStateFromAtlas().then(() => purgeExpiredTrash()).catch(error => console.error('Could not refresh trash records from MongoDB Atlas:', error.message))
}, 60 * 1000)
trashSweep.unref()
const portalStateSync = setInterval(() => {
  refreshPortalStateFromAtlas().catch(error => console.error('Could not refresh the portal cache from MongoDB Atlas:', error.message))
}, 5 * 1000)
portalStateSync.unref()
if (EMAIL_CONFIGURED) setImmediate(() => { processEmailOutbox().catch(() => {}) })
const emailSweep = setInterval(() => { processEmailOutbox().catch(() => {}) }, 15 * 1000)
emailSweep.unref()
let razorpayReconciliationInProgress = false
async function runRazorpayReconciliationSweep() {
  if ((!RAZORPAY_CONFIGURED && !CASHFREE_CONFIGURED) || razorpayReconciliationInProgress) return
  razorpayReconciliationInProgress = true
  try {
    await refreshPortalStateFromAtlas()
    await reconcilePendingRazorpayPayments()
    await reconcilePendingRazorpayRefunds()
    await reconcilePendingCashfreePayments()
    await reconcilePendingCashfreeRefunds()
  } catch (error) {
    console.error('Could not refresh payment reconciliation data:', error.message)
  } finally {
    razorpayReconciliationInProgress = false
  }
}
setImmediate(() => { runRazorpayReconciliationSweep().catch(() => {}) })
const razorpayReconciliationSweep = setInterval(() => { runRazorpayReconciliationSweep().catch(() => {}) }, 60 * 1000)
razorpayReconciliationSweep.unref()
server.listen(PORT, '0.0.0.0', () => console.log(`Gouri Agency Portal listening on port ${PORT} using MongoDB Atlas`))
const runDueReminderSchedule = async () => {
  try { await processDueReminderSchedule() }
  catch (error) { console.error('Could not process due reminder schedule:', error.message) }
}
setTimeout(() => { runDueReminderSchedule().catch(() => {}) }, 10_000)
setInterval(() => { runDueReminderSchedule().catch(() => {}) }, 60_000)
