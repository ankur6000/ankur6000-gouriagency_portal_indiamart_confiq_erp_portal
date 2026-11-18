import indiaHolidayData from './indiaPublicHolidays2026.json' with { type: 'json' }
import { indiaHolidayStates } from './indiaHolidayStates.js'

const stateAliases = { CT: 'CG', OR: 'OD', TG: 'TS', UT: 'UK' }

const regionalSources = {
  AN: {
    label: 'Andaman and Nicobar Administration · Holiday List 2026',
    url: 'https://cpao.andamannicobar.gov.in/employee-service.php?slug=holiday-list',
    note: 'Administration list. Bakrid is shown on the revised date, 28 May 2026.'
  },
  DN: {
    label: 'DNH & DD Administration · Holiday List 2026',
    url: 'https://ddd.gov.in/document/holiday-list-2026/',
    note: 'Union territory administration list.'
  },
  HR: {
    label: 'Government of Haryana · Public holidays 2026 and May revision',
    url: 'https://csharyana.gov.in/WriteReadData/Notifications-%26-Orders/Human-Resources-I/15669.pdf',
    updateUrl: 'https://prms.prharyana.gov.in/press-release/2024',
    note: 'The Id-ul-Zuha date uses Haryana’s 2026 revision to 28 May.'
  },
  LA: {
    label: 'Ladakh Administration · Holiday orders 2026',
    url: 'https://ladakh.gov.in/gad/page/2/',
    updateUrls: [
      { label: 'Eid-ul-Azha date change · Order 259-LA(GAD)', url: 'https://ladakh.gov.in/gad/page/2/' },
      { label: 'Eid-e-Ghadeer date change · Order 274-LA(GAD)', url: 'https://ladakh.gov.in/gad/page/2/' }
    ],
    note: 'The list includes union territory holidays and district-specific holidays. Eid dates reflect the later Ladakh Administration orders.'
  },
  LD: {
    label: 'Lakshadweep Administration · Holiday List 2026 and amendment',
    url: 'https://lakshadweep.gov.in/notice/holiday-list-for-the-year-2026/',
    updateUrl: 'https://lakshadweep.gov.in/notice/om-change-in-the-date-of-holiday-on-account-of-id-ul-zuha-bakrid-in-kavaratti-during-the-year-2026/',
    note: 'The Bakrid entry reflects the Administration’s Kavaratti amendment. Check island-specific notices for local variations.'
  },
  PB: {
    label: 'Government of Punjab · Notification No. 06/01/2025-2PP3/781',
    url: 'https://punjab.gov.in/wp-content/uploads/2025/12/Calender-2026.pdf',
    note: 'Public holidays for Punjab Government public offices. The notice says Guru Gobind Singh Ji’s birthday will be announced separately, so no unconfirmed date is inserted.'
  },
  PY: {
    label: 'Puducherry Gazette · G.O. Ms. Nos. 2, 3, 22, 73 and 108',
    url: 'https://www.py.gov.in/sites/default/files/listofholidays-2026.pdf.pdf',
    updateUrls: [
      { label: 'Pongal holiday orders · G.O. Ms. Nos. 2 and 3', url: 'https://www.py.gov.in/gos-and-notification' },
      { label: 'Ramzan date correction · G.O. Ms. No. 22', url: 'https://www.py.gov.in/sites/default/files/home19032026go22.pdf' },
      { label: 'Deepavali date order · G.O. Ms. No. 108', url: 'https://www.py.gov.in/sites/default/files/home04112026go108.pdf' }
    ],
    note: 'Puducherry, Karaikal, Mahe and Yanam calendars are combined; region-specific dates are identified beside each holiday.'
  }
}

const holidayOverrides = {
  AN: [
    ['2026-01-26', 'Republic Day'], ['2026-03-04', 'Holi'], ['2026-03-21', 'Id-ul-Fitr'],
    ['2026-03-26', 'Ram Navami'], ['2026-04-03', 'Good Friday'], ['2026-05-01', 'Buddha Purnima'],
    ['2026-05-28', 'Id-ul-Zuha (Bakrid)'], ['2026-06-26', 'Muharram'],
    ['2026-08-15', 'Independence Day'], ['2026-08-26', 'Milad-un-Nabi and Onam'],
    ['2026-10-02', 'Gandhi Jayanti'], ['2026-10-20', 'Dussehra'], ['2026-11-08', 'Diwali'],
    ['2026-11-24', 'Guru Nanak Jayanti'], ['2026-12-25', 'Christmas Day']
  ],
  DN: [
    ['2026-01-14', 'Makar Sankranti'], ['2026-01-26', 'Republic Day'], ['2026-03-04', 'Holi'],
    ['2026-03-19', 'Chaitra Sukladi / Gudi Padava / Ugadi / Cheti Chand'], ['2026-03-21', 'Id-ul-Fitr'],
    ['2026-03-26', 'Ram Navami'], ['2026-03-31', 'Mahavir Jayanti'], ['2026-04-03', 'Good Friday'],
    ['2026-08-15', 'Independence Day / Parsi New Year'], ['2026-08-26', 'Milad-un-Nabi'],
    ['2026-08-28', 'Raksha Bandhan'], ['2026-09-04', 'Janmashtami'], ['2026-09-14', 'Ganesh Chaturthi'],
    ['2026-10-02', 'Gandhi Jayanti'], ['2026-10-20', 'Dussehra'], ['2026-11-09', 'Govardhan Pooja'],
    ['2026-12-25', 'Christmas Day']
  ],
  HR: [
    ['2026-01-23', 'Sir Chottu Ram Jayanti / Basant Panchmi'], ['2026-01-26', 'Republic Day'],
    ['2026-03-04', 'Holi'], ['2026-03-21', 'Id-ul-Fitr', 'Bank holiday under the Negotiable Instruments Act', 'RBI bank holiday'],
    ['2026-03-23', 'Shaheedi Diwas of Bhagat Singh, Rajguru and Sukhdev'], ['2026-03-26', 'Ram Navmi'],
    ['2026-03-31', 'Mahavir Jayanti'], ['2026-04-01', 'Annual closing of bank accounts', 'Applicable to banks', 'Bank-only closing'],
    ['2026-04-14', 'Dr. B. R. Ambedkar Jayanti / Vaisakhi'], ['2026-05-01', 'Buddha Purnima', 'Bank holiday under the Negotiable Instruments Act', 'RBI bank holiday'],
    ['2026-05-28', 'Id-ul-Zuha (Bakrid)', 'Revised from 27 May by Haryana Government order'],
    ['2026-06-17', 'Maharana Pratap Jayanti'], ['2026-06-29', 'Sant Kabir Jayanti'],
    ['2026-07-31', 'Shaheed Udham Singh Martyrdom Day'], ['2026-08-15', 'Independence Day', 'Bank holiday under the Negotiable Instruments Act', 'RBI bank holiday'],
    ['2026-08-28', 'Raksha Bandhan'], ['2026-09-04', 'Janmashtami'], ['2026-09-23', 'Shaheed Divas / Haryana War Heroes Martyrdom Day'],
    ['2026-10-02', 'Mahatma Gandhi Jayanti'], ['2026-10-20', 'Dussehra'], ['2026-10-26', 'Maharishi Valmiki Jayanti'],
    ['2026-11-09', 'Vishvakarma Day'], ['2026-11-24', 'Guru Nanak Dev Jayanti'], ['2026-12-25', 'Christmas Day']
  ],
  LA: [
    ['2026-01-26', 'Republic Day'], ['2026-03-04', 'Holi'], ['2026-03-21', 'Nauroz / Id-ul-Fitr'],
    ['2026-04-14', 'Baisakhi / Dr. B. R. Ambedkar Jayanti'], ['2026-05-01', 'Buddha Purnima'],
    ['2026-05-28', 'Id-ul-Azha (Bakrid)'], ['2026-06-26', 'Muharram'], ['2026-08-15', 'Independence Day'],
    ['2026-08-26', 'Milad-un-Nabi'], ['2026-10-02', 'Mahatma Gandhi Jayanti'], ['2026-10-20', 'Dussehra'],
    ['2026-06-05', 'Eid-e-Ghadeer', 'Kargil District only · moved from 4 June by Order 274-LA(GAD)'],
    ['2026-06-24', 'Hemis Tsechu', 'Leh District only'], ['2026-08-04', 'Chehlum (Youm-e-Arbaeen)', 'Kargil District only'],
    ['2026-11-08', 'Diwali'], ['2026-11-24', 'Guru Nanak Jayanti'], ['2026-12-09', 'Losar'], ['2026-12-25', 'Christmas Day'],
    ['2026-02-16', 'Mela Dosmochey', 'Leh District and Zanskar Sub-Division only']
  ],
  LD: [
    ['2026-01-14', 'Pongal / Makar Sankranti'], ['2026-01-26', 'Republic Day'], ['2026-03-04', 'Holi'],
    ['2026-03-21', 'Id-ul-Fitr'], ['2026-03-26', 'Ram Navami'], ['2026-03-31', 'Mahavir Jayanti'],
    ['2026-05-01', 'Buddha Purnima'], ['2026-05-27', 'Id-ul-Zuha (Bakrid)', 'All islands in the original administration notice; Kavaratti was moved to 28 May'],
    ['2026-05-28', 'Id-ul-Zuha (Bakrid)', 'Kavaratti only · revised by administration order'], ['2026-06-26', 'Muharram'],
    ['2026-08-15', 'Independence Day / Nauroz'], ['2026-08-26', 'Onam / Milad-un-Nabi'],
    ['2026-09-04', 'Janmashtami'], ['2026-09-14', 'Ganesh Chaturthi'], ['2026-10-02', 'Gandhi Jayanti'],
    ['2026-10-20', 'Dussehra'], ['2026-11-24', 'Guru Nanak Jayanti'], ['2026-12-25', 'Christmas Day']
  ],
  PB: [
    ['2026-01-26', 'Republic Day'], ['2026-02-01', 'Birthday of Sri Guru Ravidas Ji'], ['2026-02-15', 'Maha Shivaratri'],
    ['2026-03-04', 'Holi'], ['2026-03-21', 'Id-ul-Fitr'],
    ['2026-03-23', 'Shaheedi Diwas of Bhagat Singh, Sukhdev and Rajguru'], ['2026-03-26', 'Ram Navami'],
    ['2026-03-31', 'Mahavir Jayanti'], ['2026-04-03', 'Good Friday'], ['2026-04-08', 'Birthday of Sri Guru Nabha Dass Ji'],
    ['2026-04-14', 'Vaisakhi / Dr. B. R. Ambedkar Jayanti'], ['2026-04-19', 'Birthday of Lord Parshuram Ji'],
    ['2026-05-01', 'May Day'], ['2026-05-27', 'Id-ul-Zuha (Bakrid)'], ['2026-06-18', 'Martyrdom Day of Sri Guru Arjun Dev Ji'],
    ['2026-06-29', 'Kabir Jayanti'], ['2026-07-31', 'Martyrdom Day of Shaheed Udham Singh'], ['2026-08-15', 'Independence Day'],
    ['2026-09-04', 'Janam Ashtami'], ['2026-10-02', 'Mahatma Gandhi Jayanti'], ['2026-10-11', 'Maharaja Agrasain Jayanti'],
    ['2026-10-20', 'Dussehra'], ['2026-10-26', 'Birthday of Maharishi Valmiki Ji'], ['2026-11-08', 'Diwali'],
    ['2026-11-09', 'Vishwakarma Day'], ['2026-11-16', 'Martyrdom Day of S. Kartar Singh Sarabha Ji'],
    ['2026-11-24', 'Birthday of Sri Guru Nanak Dev Ji'], ['2026-12-14', 'Martyrdom Day of Sri Guru Teg Bahadur Ji'],
    ['2026-12-25', 'Christmas Day'], ['2026-12-28', 'Shaheedi Sabha, Shri Fatehgarh Sahib']
  ],
  PY: [
    ['2026-01-01', 'New Year', 'All regions'],
    ['2026-01-14', 'Bhogi / Pongal celebration', 'Puducherry, Karaikal and Yanam · public holiday order issued 13 January'],
    ['2026-01-15', 'Pongal', 'Puducherry, Karaikal and Yanam'],
    ['2026-01-16', 'Thiruvalluvar Day / Mattu Pongal', 'Puducherry and Karaikal'],
    ['2026-01-16', 'Kanuma', 'Yanam'],
    ['2026-01-17', 'Uzhavar Thirunal', 'Puducherry, Karaikal and Yanam · bank holiday order issued 15 January', 'RBI bank holiday'],
    ['2026-01-26', 'Republic Day', 'All regions'],
    ['2026-03-20', 'Ramzan (Id-ul-Fitr)', 'Mahe'],
    ['2026-03-21', 'Ramzan (Id-ul-Fitr)', 'Puducherry, Karaikal and Yanam · revised by G.O. Ms. No. 22'],
    ['2026-04-03', 'Good Friday', 'All regions'],
    ['2026-04-14', 'Tamil New Year / Dr. B. R. Ambedkar Jayanti', 'Puducherry and Karaikal'],
    ['2026-04-14', 'Vishu 1st Day / Dr. B. R. Ambedkar Jayanti', 'Mahe'],
    ['2026-04-14', 'Dr. B. R. Ambedkar Jayanti', 'Yanam'],
    ['2026-04-15', 'Vishu 2nd Day', 'Mahe'],
    ['2026-05-01', 'May Day', 'All regions'],
    ['2026-05-27', 'Bakrid (Id-ul-Alha)', 'Mahe'],
    ['2026-05-28', 'Bakrid (Id-ul-Alha)', 'Puducherry, Karaikal and Yanam'],
    ['2026-08-15', 'Independence Day', 'All regions'],
    ['2026-08-25', 'Onam 1st Day / Milad-un-Nabi', 'Mahe'],
    ['2026-08-26', 'Milad-un-Nabi', 'Puducherry, Karaikal and Yanam'],
    ['2026-08-26', 'Onam 2nd Day', 'Mahe'],
    ['2026-09-14', 'Vinayagar Chathurthi', 'Puducherry, Karaikal and Yanam'],
    ['2026-10-02', 'Gandhi Jayanti', 'All regions'],
    ['2026-10-15', 'St. Theresa Festival', 'Mahe'],
    ['2026-10-19', 'Saraswathi Pooja / Ayudha Pooja', 'Puducherry and Karaikal'],
    ['2026-10-19', 'Mahanavami', 'Mahe'],
    ['2026-10-19', 'Mahanavami / Ayudha Pooja', 'Yanam'],
    ['2026-11-01', 'Puducherry Liberation Day', 'All regions'],
    ['2026-11-09', 'Deepavali', 'All regions · date changed by G.O. Ms. No. 108 dated 4 November 2026'],
    ['2026-12-25', 'Christmas Day', 'All regions']
  ]
}

const emojiRules = [
  [/republic|independence|gandhi|national|statehood|formation/i, '🇮🇳'],
  [/eid|muharram|shab|ramzan|milad|bakrid|nauroz/i, '🌙'],
  [/christmas|good friday|easter/i, '🎄'],
  [/holi|doljatra/i, '🎨'],
  [/puja|durga|diwali|deepavali|lakshmi|dussehra/i, '🪔'],
  [/buddha|mahabir|mahavir|parshwanath/i, '🪷'],
  [/jayanti|birthday/i, '🌼'],
  [/labour|workers|may day/i, '🛠️']
]

function emojiFor(name) {
  return emojiRules.find(([pattern]) => pattern.test(name))?.[1] || '🎉'
}

function holidayFromRow(row, regionNote = '') {
  return {
    date: row.date,
    name: row.name,
    emoji: emojiFor(row.name),
    category: 'RBI bank holiday',
    ...(regionNote ? { note: regionNote } : {})
  }
}

function fromOverride(stateCode) {
  const rows = holidayOverrides[stateCode]
  if (!rows) return null
  const source = regionalSources[stateCode === 'DD' ? 'DN' : stateCode]
  return {
    year: 2026,
    region: `${indiaHolidayStates.find(item => item.code === stateCode || item.codes?.includes(stateCode))?.name || 'India'}, India`,
    notification: '2026 government holiday notice',
    sourceLabel: source.label,
    sourceUrl: source.url,
    ...(source.updateUrls ? { updateUrls: source.updateUrls } : {}),
    ...(source.updateUrl ? { updateUrl: source.updateUrl } : {}),
    holidays: rows.map(([date, name, note = '', category = 'Public holiday']) => ({ date, name, emoji: emojiFor(name), category, ...(note ? { note } : {}) })),
    coverageNote: `${source.note} Religious dates can be amended by later government orders.`
  }
}

export function createIndiaHolidayCalendar(year, stateCode) {
  if (Number(year) !== 2026) return null

  const state = indiaHolidayStates.find(item => item.code === stateCode || item.codes?.includes(stateCode))
  if (!state) return null
  const override = fromOverride(stateCode)
  if (override) return override

  const normalizedCode = stateAliases[stateCode] || stateCode
  const requestedLists = normalizedCode === 'JK'
    ? ['JK', 'JK-KASHMIR']
    : normalizedCode === 'KL'
      ? ['KL', 'KL-TVM']
      : [normalizedCode]

  const rows = indiaHolidayData.rows.filter(row => {
    const states = row.states.split(/\s+/).filter(Boolean)
    const approximate = row.statesApprox.split(/\s+/).filter(Boolean)
    const mappedOffice = (row.rbiList === 'JK-KASHMIR' && normalizedCode === 'JK') || (row.rbiList === 'KL-TVM' && normalizedCode === 'KL')
    return requestedLists.includes(row.rbiList) && (states.includes(normalizedCode) || mappedOffice) && !approximate.includes(normalizedCode)
  })
  if (!rows.length) return null

  const byKey = new Map()
  for (const row of rows) {
    const note = stateCode === 'KL'
      ? (row.rbiList === 'KL-TVM' ? 'Thiruvananthapuram RBI region' : 'Kochi RBI region')
      : stateCode === 'JK' && row.rbiList === 'JK-KASHMIR'
        ? 'Srinagar RBI region'
        : stateCode === 'JK'
          ? 'Jammu RBI region'
          : ''
    const holiday = holidayFromRow(row, note)
    const key = `${holiday.date}-${holiday.name}`
    if (!byKey.has(key)) byKey.set(key, holiday)
  }

  const regions = requestedLists.length > 1 ? requestedLists.join(' + ') : requestedLists[0]
  const multiRegionNote = stateCode === 'KL'
    ? 'Kerala combines the RBI Kochi and Thiruvananthapuram regional calendars; each entry is marked by region.'
    : stateCode === 'JK'
      ? 'Jammu and Kashmir combines the RBI Jammu and Srinagar regional calendars; each entry is marked by region.'
      : 'Dates are taken from the exact RBI regional office list assigned to this state.'

  return {
    year: 2026,
    region: `${state.name}, India`,
    notification: `RBI regional bank holiday list - ${regions} - 2026-11-01 snapshot`,
    sourceLabel: 'Reserve Bank of India · Regional holiday matrix',
    sourceUrl: 'https://www.rbi.org.in/Scripts/HolidayMatrixDisplay.aspx',
    attribution: indiaHolidayData.attribution,
    holidays: [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)),
    coverageNote: `${multiRegionNote} This is the RBI bank holiday schedule, not a complete school, business or local-government closure list. Moon-based dates and additional local closures may be revised by later notices.`
  }
}
