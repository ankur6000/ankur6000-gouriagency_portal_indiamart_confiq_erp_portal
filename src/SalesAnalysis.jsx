import React, { useState } from 'react'
import { Package } from './icons.jsx'

const TIME_ZONE = 'Asia/Kolkata'
const formatMoney = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value || 0))
const profitColors = { profit: '#378456', loss: '#c34646', unknown: '#9aa69c', even: '#62756a' }

function salesDateKey(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function shiftDate(dateKey, { days = 0, months = 0, years = 0 } = {}) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const target = new Date(Date.UTC(year + years, month - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay) + days)
  return target.toISOString().slice(0, 10)
}

function getPeriodRange(period) {
  const end = salesDateKey(new Date())
  const shift = period === '7d' ? { days: -6 } : period === '1m' ? { months: -1 } : period === '1y' ? { years: -1 } : { years: -5 }
  return { start: shiftDate(end, shift), end }
}

function getDefaultCustomRange() {
  return getPeriodRange('7d')
}

function formatDate(dateKey) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(`${dateKey}T12:00:00Z`))
}

function getProfitState(sales, costKnown, costs) {
  if (!costKnown) return 'unknown'
  const profit = sales - costs
  return profit > 0.005 ? 'profit' : profit < -0.005 ? 'loss' : 'even'
}

function buildBreakdown(periodOrders, profiles, selectedProfile) {
  const salesOrders = periodOrders.filter(order => Number(order.amountDue || 0) > 0)
  let groups
  if (selectedProfile === 'all') {
    const byProfile = new Map()
    for (const order of salesOrders) {
      const key = order.profileId || order.shopName || order.id
      if (!byProfile.has(key)) byProfile.set(key, [])
      byProfile.get(key).push(order)
    }
    groups = [...byProfile.entries()].map(([key, orders]) => {
      const profile = profiles.find(item => item.id === key)
      const sales = orders.reduce((sum, order) => sum + Number(order.amountDue || 0), 0)
      const costKnown = orders.every(order => Number.isFinite(order.costAmount) && order.costAmount >= 0)
      const costs = costKnown ? orders.reduce((sum, order) => sum + order.costAmount, 0) : 0
      return { key, label: profile?.shopName || orders[0].shopName || 'Customer', sales, costs, costKnown, orderCount: orders.length }
    })
  } else {
    groups = salesOrders.map(order => {
      const costKnown = Number.isFinite(order.costAmount) && order.costAmount >= 0
      return { key: order.id, label: `${order.id} · ${order.shopName || 'Order'}`, sales: Number(order.amountDue || 0), costs: costKnown ? order.costAmount : 0, costKnown, orderCount: 1 }
    })
  }
  return groups.sort((a, b) => b.sales - a.sales).map(item => ({ ...item, profitState: getProfitState(item.sales, item.costKnown, item.costs) }))
}

function piePath(startAngle, endAngle) {
  const cx = 100; const cy = 100; const radius = 94
  const startX = cx + radius * Math.cos(startAngle); const startY = cy + radius * Math.sin(startAngle)
  const endX = cx + radius * Math.cos(endAngle); const endY = cy + radius * Math.sin(endAngle)
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0
  return `M ${cx} ${cy} L ${startX} ${startY} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY} Z`
}

function SalesShareChart({ items, totalSales, selectedProfile }) {
  let angle = -Math.PI / 2
  const slices = items.map(item => {
    const share = totalSales > 0 ? item.sales / totalSales : 0
    const start = angle
    angle += share * Math.PI * 2
    return { ...item, share, start, end: angle }
  })
  const chartLabel = selectedProfile === 'all' ? 'Sales share by customer profile' : 'Sales share by order for selected customer'
  return <section className="sales-chart-panel" aria-label={chartLabel}>
    <div className="sales-chart-heading"><div><span className="eyebrow">SALES DISTRIBUTION</span><h3>{selectedProfile === 'all' ? 'Sales share by profile' : 'Selected customer · sales by order'}</h3></div><span>{formatMoney(totalSales)} total sales</span></div>
    {slices.length ? <div className="sales-chart-content">
      <svg className="sales-pie-chart" viewBox="0 0 200 200" role="img" aria-label={`${chartLabel}, ${slices.length} segment${slices.length === 1 ? '' : 's'}`}>
        {slices.length === 1
          ? <circle cx="100" cy="100" r="94" fill={profitColors[slices[0].profitState]} stroke="#fff" strokeWidth="2"><title>{slices[0].label}: 100% of sales</title></circle>
          : slices.map(slice => <path key={slice.key} d={piePath(slice.start, slice.end)} fill={profitColors[slice.profitState]} stroke="#fff" strokeWidth="2"><title>{slice.label}: {(slice.share * 100).toFixed(1)}% of sales</title></path>)}
      </svg>
      <ul className="sales-chart-legend">{slices.map(slice => <li key={slice.key}><i style={{ backgroundColor: profitColors[slice.profitState] }}/><div><strong>{slice.label}</strong><span>{(slice.share * 100).toFixed(1)}% · {formatMoney(slice.sales)} · {slice.orderCount} order{slice.orderCount === 1 ? '' : 's'}</span><small className={`sales-profit-label ${slice.profitState}`}>{slice.profitState === 'unknown' ? 'Cost data needed' : slice.profitState === 'even' ? 'Break-even' : slice.profitState === 'profit' ? `Profit ${formatMoney(slice.sales - slice.costs)}` : `Loss ${formatMoney(Math.abs(slice.sales - slice.costs))}`}</small></div></li>)}</ul>
    </div> : <div className="sales-chart-empty">No sales were recorded for this period and customer selection.</div>}
    <p className="sales-chart-note">Green means profit, red means loss, and grey means cost data is missing. Sales share is calculated from order totals.</p>
  </section>
}

export default function SalesAnalysis({ orders, profiles }) {
  const [period, setPeriod] = useState('1m')
  const [customRange, setCustomRange] = useState(getDefaultCustomRange)
  const [selectedProfile, setSelectedProfile] = useState('all')
  const [leaderboardDate, setLeaderboardDate] = useState(salesDateKey(new Date()))
  const range = period === 'custom' ? customRange : getPeriodRange(period)
  const rangeIsValid = Boolean(range.start && range.end && range.start <= range.end)
  const selectedOrders = orders.filter(order => selectedProfile === 'all' || order.profileId === selectedProfile)
  const periodOrders = selectedOrders.filter(order => {
    if (!rangeIsValid || order.status === 'Cancelled') return false
    const date = salesDateKey(order.date)
    return date && date >= range.start && date <= range.end
  })
  const periodPayments = selectedOrders.filter(order => order.status !== 'Cancelled').flatMap(order => (order.payments || []).map(payment => ({ payment }))).filter(({ payment }) => {
    if (!rangeIsValid) return false
    if (!['Paid', 'Verified'].includes(payment.status)) return false
    if (Number(payment.amount || 0) - Number(payment.amountRefunded || 0) <= 0.005) return false
    const date = salesDateKey(payment.paidAt || payment.reviewedAt || payment.submittedAt)
    return date && date >= range.start && date <= range.end
  })
  const salesTotal = periodOrders.reduce((sum, order) => sum + Number(order.amountDue || 0), 0)
  const receivedTotal = periodPayments.reduce((sum, row) => sum + Math.max(0, Number(row.payment.amount || 0) - Number(row.payment.amountRefunded || 0)), 0)
  const outstandingTotal = periodOrders.reduce((sum, order) => sum + Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0)), 0)
  const outstandingOrderCount = periodOrders.filter(order => Number(order.amountDue || 0) - Number(order.amountPaid || 0) > 0.005).length
  const costsKnown = periodOrders.length > 0 && periodOrders.every(order => Number.isFinite(order.costAmount) && order.costAmount >= 0)
  const totalCosts = costsKnown ? periodOrders.reduce((sum, order) => sum + order.costAmount, 0) : 0
  const profit = salesTotal - totalCosts
  const profitState = getProfitState(salesTotal, costsKnown, totalCosts)
  const breakdown = buildBreakdown(periodOrders, profiles, selectedProfile)
  const dailyCustomerSales = new Map()
  for (const order of orders) {
    if (order.status === 'Cancelled' || salesDateKey(order.date) !== leaderboardDate || Number(order.amountDue || 0) <= 0) continue
    const key = order.profileId || order.shopName || order.id
    const current = dailyCustomerSales.get(key) || { key, shopName: profiles.find(profile => profile.id === order.profileId)?.shopName || order.shopName || 'Customer', sales: 0, orderCount: 0 }
    current.sales += Number(order.amountDue || 0)
    current.orderCount++
    dailyCustomerSales.set(key, current)
  }
  const topCustomers = [...dailyCustomerSales.values()].sort((a, b) => b.sales - a.sales).slice(0, 5)
  const isToday = leaderboardDate === salesDateKey(new Date())
  return <section className="sales-analysis-panel" aria-labelledby="sales-analysis-title">
    <div className="panel-heading"><div><span className="eyebrow">BUSINESS PERFORMANCE</span><h2 id="sales-analysis-title">Sales analysis</h2><p>Compare sales, collections, outstanding balances, and recorded profit or loss.</p></div><Package size={22}/></div>
    <div className="sales-analysis-filters">
      <label>Report period<select value={period} onChange={event => setPeriod(event.target.value)}><option value="7d">Last 7 days</option><option value="1m">Last month</option><option value="1y">Last 1 year</option><option value="5y">Last 5 years</option><option value="custom">Custom date range</option></select></label>
      <label>Customer report<select value={selectedProfile} onChange={event => setSelectedProfile(event.target.value)}><option value="all">All customer profiles</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.shopName || profile.gstNumber}</option>)}</select></label>
      <span className="sales-analysis-range">{rangeIsValid ? `${formatDate(range.start)} – ${formatDate(range.end)} · IST` : 'Choose a valid date range'}</span>
      {period === 'custom' && <div className="sales-custom-date-range">
        <label>From date<input type="date" value={customRange.start} max={customRange.end || salesDateKey(new Date())} onChange={event => setCustomRange(current => ({ ...current, start: event.target.value }))}/></label>
        <label>To date<input type="date" value={customRange.end} min={customRange.start} max={salesDateKey(new Date())} onChange={event => setCustomRange(current => ({ ...current, end: event.target.value }))}/></label>
      </div>}
    </div>
    <div className="sales-metrics-grid">
      <article><span>Total sales</span><strong>{formatMoney(salesTotal)}</strong><small>{periodOrders.length} order{periodOrders.length === 1 ? '' : 's'} in period</small></article>
      <article><span>Payments received</span><strong>{periodPayments.length}</strong><small>{formatMoney(receivedTotal)} collected in period</small></article>
      <article className="sales-outstanding-metric"><span>Outstanding balance</span><strong>{formatMoney(outstandingTotal)}</strong><small>{outstandingOrderCount} order{outstandingOrderCount === 1 ? '' : 's'} still unpaid</small></article>
      <article><span>All orders</span><strong>{periodOrders.length}</strong><small>Placed in selected period</small></article>
      <article className={`sales-profit-metric ${profitState}`}><span>Gross profit / loss</span><strong>{costsKnown ? formatMoney(profit) : 'Cost data needed'}</strong><small>{costsKnown ? (profitState === 'loss' ? 'Recorded order costs exceed sales' : profitState === 'even' ? 'Sales and costs are even' : 'Sales less recorded order costs') : 'Enter internal cost on each order'}</small></article>
    </div>
    <SalesShareChart items={breakdown} totalSales={salesTotal} selectedProfile={selectedProfile}/>
    <section className="daily-top-customers" aria-labelledby="daily-top-customers-title"><div className="daily-top-customers-heading"><div><span className="eyebrow">DAILY CUSTOMER RANKING</span><h3 id="daily-top-customers-title">Top 5 customers {isToday ? 'today' : 'for this day'}</h3><p>Ranked by order value placed on the selected date.</p></div><label>Date<input type="date" value={leaderboardDate} max={salesDateKey(new Date())} onChange={event => setLeaderboardDate(event.target.value)}/></label></div>{topCustomers.length ? <ol className="daily-top-customer-list">{topCustomers.map((customer, index) => <li key={customer.key}><span className="daily-top-customer-medal" aria-label={`Rank ${index + 1}`}>{['🥇', '🥈', '🥉', '🏅', '⭐'][index]}</span><div><strong>{customer.shopName}</strong><small>{customer.orderCount} order{customer.orderCount === 1 ? '' : 's'} on {formatDate(leaderboardDate)}</small></div><b>{formatMoney(customer.sales)}</b></li>)}</ol> : <div className="sales-chart-empty">No non-cancelled orders with a recorded sale were found for this date.</div>}</section>
    <p className="sales-analysis-note">Profit/loss uses order total minus the internal cost entered by an admin. Missing costs are not assumed to be zero. Payments received count only verified or captured transactions; outstanding balances reflect current paid amounts on orders placed in the selected period.</p>
  </section>
}
