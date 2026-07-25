const API_BASE = window.location.origin.startsWith('http') ? window.location.origin : 'http://127.0.0.1:3000';

// Chart instances
let barChartInst, doughnutChartInst, lineChartInst, hbarChartInst;
let currentSummary;
let currentQueryTab = 'all';

// Active chart selection (default: all enabled)
let activeCharts = {
  bar: true,
  doughnut: true,
  line: true,
  hbar: true
};

// Dashboard — rich distinct color palette (professional multi-color)
const CHART_COLORS = [
  '#4E9AF1', // vivid blue
  '#F4685C', // coral red
  '#2EC4B6', // teal
  '#F7B731', // amber
  '#A55EEA', // purple
  '#45C97A', // emerald green
  '#FF8C42', // orange
  '#E84393', // magenta
  '#00B4D8', // sky blue
  '#6BCB77', // lime green
];

// Gold accent kept only for non-dashboard UI elements
const BRAND_GOLD = '#FFD700';
const CHART_TEXT  = '#e8e0d0';
const CHART_MUTED = '#9a9080';
const CHART_GRID  = 'rgba(255,255,255,0.07)';

// Per-chart color sets for clear distinction
const BAR_GRADIENT_START  = '#4E9AF1';
const BAR_GRADIENT_MID    = '#2EC4B6';
const BAR_GRADIENT_END    = '#45C97A';
const LINE_COLOR          = '#F7B731';
const LINE_FILL           = 'rgba(247,183,49,0.13)';

// -- INIT ----------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('fileInput').addEventListener('change', uploadFile);
  document.getElementById('queryForm').addEventListener('submit', e => { e.preventDefault(); runQuery(); });
  initChartSelector();
  checkAIStatus();
  await loadDashboard();
});

// Check if Gemini AI is enabled
async function checkAIStatus() {
  const badge = document.getElementById('aiStatusBadge');
  if (!badge) return;
  
  try {
    const response = await fetch(`${API_BASE}/api/ai-status`);
    const status = await response.json();
    
    if (status.geminiEnabled) {
      badge.className = 'ai-status-badge ai-active';
      badge.textContent = `✨ AI Active (${status.model})`;
    } else {
      badge.className = 'ai-status-badge ai-local';
      badge.textContent = '🔧 Local Parsing Mode';
    }
  } catch (e) {
    badge.className = 'ai-status-badge ai-local';
    badge.textContent = '🔧 Local Parsing Mode';
  }
}

// -- NAVIGATION ----------------------------------------------------------------

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelectorAll('.sidebar button').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`[data-page="${id}"]`);
  if (btn) btn.classList.add('active');
}

// -- MODULE 1: UPLOAD & QUALITY ------------------------------------------------

async function uploadFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  setStatus(`Reading ${file.name}…`);

  try {
    const text = await file.text();
    const rows = parseCSV(text);
    if (!rows.length) { setStatus('No valid rows found. Upload a CSV with a header row.', true); return; }

    const response = await fetch(`${API_BASE}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Upload failed');

    setStatus(`Uploaded ${result.count} rows from "${file.name}".`);
    renderSchema(result.summary.schema || []);
    renderValidationPanel(result);
    renderQualityPanels(result.cleaning, result.count);
    renderCleanSummary(result);
    renderDashboard(result.summary);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function renderValidationPanel(result) {
  const panel = document.getElementById('validationPanel');
  const stats = document.getElementById('validationStats');
  panel.classList.remove('hidden');

  const schema = result.summary.schema || [];
  const numericCols = schema.filter(s => s.type === 'Number').length;
  const textCols = schema.filter(s => s.type === 'Text').length;

  stats.innerHTML = `
    <div class="vstat cyan"><span>${result.count}</span><small>Total Rows</small></div>
    <div class="vstat green"><span>${schema.length}</span><small>Columns</small></div>
    <div class="vstat amber"><span>${numericCols}</span><small>Numeric</small></div>
    <div class="vstat rose"><span>${textCols}</span><small>Text</small></div>
  `;
}

function renderQualityPanels(cleaning, totalRows) {
  if (!cleaning) return;

  // Add rendering for Data Quality Score Card
  if (cleaning.validation) {
    const v = cleaning.validation;
    
    const qsCard = document.getElementById('qualityScoreCard');
    if (qsCard) {
      qsCard.classList.remove('hidden');
      document.getElementById('qualityScoreNumber').textContent = v.qualityScore;
      document.getElementById('qualityScoreBadge').textContent = v.qualityScore >= 90 ? 'Excellent' : (v.qualityScore >= 70 ? 'Good' : 'Poor');
      
      const ringFill = document.getElementById('scoreRingCircle');
      if (ringFill) {
        const dashOffset = 314 - (314 * v.qualityScore) / 100;
        ringFill.style.strokeDasharray = '314';
        ringFill.style.strokeDashoffset = dashOffset;
        ringFill.style.stroke = v.qualityScore >= 90 ? '#45C97A' : (v.qualityScore >= 70 ? '#F7B731' : '#F4685C');
      }
      
      document.getElementById('completenessBar').style.width = v.completeness + '%';
      document.getElementById('completenessValue').textContent = v.completeness + '%';
      document.getElementById('consistencyBar').style.width = v.consistency + '%';
      document.getElementById('consistencyValue').textContent = v.consistency + '%';
      document.getElementById('accuracyBar').style.width = v.accuracy + '%';
      document.getElementById('accuracyValue').textContent = v.accuracy + '%';
    }

    const colCard = document.getElementById('columnAnalysisCard');
    const colList = document.getElementById('columnAnalysisList');
    if (colCard && colList && v.columnAnalysis) {
      colCard.classList.remove('hidden');
      colList.innerHTML = v.columnAnalysis.map(c => `
        <div class="schema-row" style="margin-bottom: 8px;">
          <span>${escapeHtml(c.name)} <small>(${c.type})</small></span>
          <small>Missing: ${c.missing} | Invalid: ${c.invalid}</small>
        </div>
      `).join('');
    }

    const issueCard = document.getElementById('validationIssuesCard');
    const issueList = document.getElementById('validationIssuesList');
    if (issueCard && issueList && v.suggestions && v.suggestions.length > 0) {
      issueCard.classList.remove('hidden');
      issueList.innerHTML = `<ul style="margin:0; padding-left:20px;">${v.suggestions.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`;
    }
  }

  // Missing Values Panel
  const missingPanel = document.getElementById('missingPanel');
  if (cleaning.missingDetail && cleaning.missingDetail.length > 0) {
    missingPanel.classList.remove('hidden');
    document.getElementById('missingSubtitle').textContent =
      `${cleaning.missingValues} missing cell${cleaning.missingValues !== 1 ? 's' : ''} across ${cleaning.missingDetail.length} column${cleaning.missingDetail.length !== 1 ? 's' : ''}`;

    const tbody = document.getElementById('missingTableBody');
    tbody.innerHTML = cleaning.missingDetail.map(d => `
      <tr>
        <td>${escapeHtml(d.column)}</td>
        <td class="num">${d.count}</td>
        <td class="num">${Math.round(d.count / totalRows * 100)}%</td>
      </tr>
    `).join('');
  } else {
    missingPanel.classList.add('hidden');
  }

  // Duplicate Records Panel
  const dupPanel = document.getElementById('duplicatePanel');
  if (cleaning.duplicateRows && cleaning.duplicateRows.length > 0) {
    dupPanel.classList.remove('hidden');
    document.getElementById('duplicateSubtitle').textContent =
      `${cleaning.duplicatesRemoved} duplicate row${cleaning.duplicatesRemoved !== 1 ? 's' : ''} removed before storing`;

    const cols = Object.keys(cleaning.duplicateRows[0] || {}).slice(0, 6);
    const wrap = document.getElementById('duplicateTableWrap');
    wrap.innerHTML = `
      <table class="quality-table">
        <thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
        <tbody>
          ${cleaning.duplicateRows.map(row => `<tr>${cols.map(c => `<td>${escapeHtml(formatCell(row[c]))}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    `;
  } else {
    dupPanel.classList.add('hidden');
  }
}

function renderCleanSummary(result) {
  const panel = document.getElementById('cleanSummary');
  panel.classList.remove('hidden');
  document.getElementById('cleanSummaryText').textContent =
    `${result.count} rows stored — dataset ready for analysis.`;
  const c = result.cleaning;
  const parts = [];
  if (c.duplicatesRemoved > 0) parts.push(`${c.duplicatesRemoved} duplicate${c.duplicatesRemoved !== 1 ? 's' : ''} removed`);
  if (c.missingValues > 0) parts.push(`${c.missingValues} missing value${c.missingValues !== 1 ? 's' : ''} detected`);
  if (!parts.length) parts.push('No issues found — data is clean');
  document.getElementById('cleanSummaryDetails').textContent = parts.join(' · ');
  
  // Render advanced validation if available
  if (c.validation) {
    renderQualityScore(c.validation);
    renderColumnAnalysis(c.validation);
    renderValidationIssues(c.validation);
  }
}

function renderQualityScore(validation) {
  const card = document.getElementById('qualityScoreCard');
  card.classList.remove('hidden');
  
  const score = validation.qualityScore;
  const badge = document.getElementById('qualityScoreBadge');
  const number = document.getElementById('qualityScoreNumber');
  const circle = document.getElementById('scoreRingCircle');
  
  let color, label;
  if (score >= 90) { color = '#6BCB77'; label = 'Excellent'; }
  else if (score >= 75) { color = '#4E9AF1'; label = 'Good'; }
  else if (score >= 60) { color = '#F7B731'; label = 'Fair'; }
  else { color = '#F4685C'; label = 'Needs Work'; }
  
  badge.textContent = label;
  badge.style.color = color;
  badge.style.borderColor = color;
  
  number.textContent = score;
  number.style.color = color;
  
  const circumference = 314.16;
  const offset = circumference - (score / 100) * circumference;
  circle.style.strokeDashoffset = offset;
  circle.style.stroke = color;
  
  document.getElementById('completenessBar').style.width = validation.completeness + '%';
  document.getElementById('completenessBar').style.background = validation.completeness >= 90 ? '#6BCB77' : (validation.completeness >= 75 ? '#F7B731' : '#F4685C');
  document.getElementById('completenessValue').textContent = validation.completeness + '%';
  
  document.getElementById('consistencyBar').style.width = validation.consistency + '%';
  document.getElementById('consistencyBar').style.background = validation.consistency >= 90 ? '#6BCB77' : (validation.consistency >= 75 ? '#F7B731' : '#F4685C');
  document.getElementById('consistencyValue').textContent = validation.consistency + '%';
  
  document.getElementById('accuracyBar').style.width = validation.accuracy + '%';
  document.getElementById('accuracyBar').style.background = validation.accuracy >= 90 ? '#6BCB77' : (validation.accuracy >= 75 ? '#F7B731' : '#F4685C');
  document.getElementById('accuracyValue').textContent = validation.accuracy + '%';
}

function renderColumnAnalysis(validation) {
  const card = document.getElementById('columnAnalysisCard');
  const list = document.getElementById('columnAnalysisList');
  
  if (!validation.columnAnalysis.length) {
    card.classList.add('hidden');
    return;
  }
  
  card.classList.remove('hidden');
  list.innerHTML = validation.columnAnalysis.map(col => {
    const typeIcon = col.type === 'numeric' ? '🔢' : (col.type === 'text' ? '📝' : '🔀');
    let statsHtml = '';
    
    if (col.type === 'numeric' && col.stats) {
      statsHtml = `
        <div class="col-stats">
          <span>μ = ${col.stats.mean}</span>
          <span>σ = ${col.stats.stdDev}</span>
          <span>Median = ${col.stats.median}</span>
          <span>Range: ${col.stats.min} - ${col.stats.max}</span>
        </div>
      `;
    }
    
    const issueBadge = col.invalid > 0 || col.outliers > 0 ?
      `<span class="col-issue-badge">${col.invalid + col.outliers} issues</span>` : '';
    
    return `
      <div class="col-analysis-item">
        <div class="col-header">
          <span class="col-type-icon">${typeIcon}</span>
          <strong>${escapeHtml(col.name)}</strong>
          <span class="col-type-badge">${col.type}</span>
          ${issueBadge}
        </div>
        <div class="col-meta">
          <span>${col.filled}/${col.total} filled</span>
          <span>${col.unique} unique</span>
          ${col.missing > 0 ? `<span class="text-warn">${col.missing} missing</span>` : ''}
        </div>
        ${statsHtml}
      </div>
    `;
  }).join('');
}

function renderValidationIssues(validation) {
  const card = document.getElementById('validationIssuesCard');
  const list = document.getElementById('validationIssuesList');
  
  const hasIssues = validation.outliers.length > 0 || 
                    validation.invalidValues.length > 0 || 
                    validation.suggestions.length > 0;
  
  if (!hasIssues) {
    card.classList.add('hidden');
    return;
  }
  
  card.classList.remove('hidden');
  
  let html = '';
  
  if (validation.outliers.length > 0) {
    html += `<div class="issue-section">
      <h4>⚠️ Outliers Detected (${validation.outliers.length})</h4>
      <ul>${validation.outliers.slice(0, 10).map(o => 
        `<li><strong>${escapeHtml(o.column)}</strong>: ${o.value} (${o.deviation} from mean)</li>`
      ).join('')}</ul>
    </div>`;
  }
  
  if (validation.invalidValues.length > 0) {
    html += `<div class="issue-section issue-error">
      <h4>❌ Invalid Values (${validation.invalidValues.length})</h4>
      <ul>${validation.invalidValues.slice(0, 10).map(v => 
        `<li><strong>${escapeHtml(v.column)}</strong>: ${v.value} — ${escapeHtml(v.issue)}</li>`
      ).join('')}</ul>
    </div>`;
  }
  
  if (validation.suggestions.length > 0) {
    html += `<div class="issue-section issue-suggestion">
      <h4>💡 Recommendations</h4>
      <ul>${validation.suggestions.map(s => 
        `<li>${escapeHtml(s)}</li>`
      ).join('')}</ul>
    </div>`;
  }
  
  list.innerHTML = html;
}

// -- CSV PARSER ----------------------------------------------------------------

function splitCSVLines(text) {
  const lines = [];
  let currentLine = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQ = !inQ;
    if ((ch === '\n' || (ch === '\r' && text[i+1] === '\n')) && !inQ) {
      if (ch === '\r') i++; // Skip \r
      if (currentLine.trim()) lines.push(currentLine.trim());
      currentLine = '';
    } else {
      currentLine += ch;
    }
  }
  if (currentLine.trim()) lines.push(currentLine.trim());
  return lines;
}

function parseCSV(text) {
  const lines = splitCSVLines(text);
  if (lines.length < 2) return [];
  const rawHeaders = splitCSVLine(lines[0]).map(h => normalizeHeader(h));
  
  const headers = [];
  const headerCounts = {};
  rawHeaders.forEach(h => {
    if (headerCounts[h]) {
      headers.push(`${h}_${headerCounts[h]}`);
      headerCounts[h]++;
    } else {
      headerCounts[h] = 1;
      headers.push(h);
    }
  });

  return lines.slice(1).map(line => {
    const values = splitCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] ? values[i].trim() : ''; });
    return row;
  }).filter(row => Object.values(row).some(v => v !== ''));
}

function splitCSVLine(line) {
  const cells = []; let cell = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i], nx = line[i + 1];
    if (ch === '"' && nx === '"') { cell += '"'; i++; }
    else if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cells.push(cell); cell = ''; }
    else { cell += ch; }
  }
  cells.push(cell);
  return cells;
}

function normalizeHeader(v) { return String(v || '').trim().replace(/\s+/g, ' ').replace(/^./, c => c.toUpperCase()); }

// -- MODULE 2: QUERY ENGINE ----------------------------------------------------

function setQueryTab(tab) {
  currentQueryTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  // Pre-fill query hint based on tab
  const hints = { filter: 'attendance below 75', sort: 'sort by CGPA', group: 'count by department', aggregate: 'average CGPA' };
  if (hints[tab] && currentSummary) {
    const metric = currentSummary.primaryMetric || '';
    const label = currentSummary.labelColumn || '';
    const hintMap = {
      filter: metric ? `${metric} below 75` : 'attendance below 75',
      sort: metric ? `sort by ${metric}` : 'sort by CGPA',
      group: label ? `count by ${label}` : 'count by department',
      aggregate: metric ? `average ${metric}` : 'average CGPA'
    };
    if (tab !== 'all') document.getElementById('q').placeholder = `e.g. ${hintMap[tab]}`;
    else document.getElementById('q').placeholder = 'e.g. top 10 students · average CGPA · attendance below 75 · count by department';
  }
}

async function runQuery() {
  const query = document.getElementById('q').value.trim();
  const resultEl = document.getElementById('result');
  const insightEl = document.getElementById('queryInsight');

  if (!query) { resultEl.innerHTML = '<p>Enter a query first.</p>'; return; }
  resultEl.innerHTML = '<p class="pulse-text">Processing query…</p>';
  insightEl.classList.add('hidden');

  try {
    const response = await fetch(`${API_BASE}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Query failed');
    renderQueryResult(payload);
  } catch (error) {
    resultEl.innerHTML = `<p class="err-text">${escapeHtml(error.message)}</p>`;
  }
}

function renderQueryResult(payload) {
  const resultEl = document.getElementById('result');
  const insightEl = document.getElementById('queryInsight');

  // Show insight
  if (payload.insight) {
    insightEl.classList.remove('hidden');
    insightEl.innerHTML = `<span class="insight-icon">&#128161;</span> ${escapeHtml(payload.insight)}`;
  } else {
    insightEl.classList.add('hidden');
  }

  if (payload.type === 'group' || payload.type === 'list') {
    const cols = payload.columns || [];
    const rows = payload.rows || [];
    resultEl.innerHTML = `
      <h3 class="result-title">${escapeHtml(payload.title)}</h3>
      <div class="result-table-wrap">
        <table class="result-table">
          <thead>
            <tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${rows.map(row => `<tr>${cols.map(c => `<td>${escapeHtml(formatCell(row[c]))}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>
      <small class="result-count">${rows.length} row${rows.length !== 1 ? 's' : ''} returned</small>
    `;
    return;
  }

  resultEl.innerHTML = `
    <h3 class="result-title">${escapeHtml(payload.title)}</h3>
    <p class="metric-line">${escapeHtml(String(payload.value))}</p>
  `;
}

// -- MODULE 3: DASHBOARD -------------------------------------------------------

async function loadDashboard() {
  try {
    const response = await fetch(`${API_BASE}/api/summary`);
    const summary = await response.json();
    if (!response.ok) throw new Error(summary.error || 'Dashboard failed');
    renderSchema(summary.schema || []);
    renderDashboard(summary);
    
    // Load AI insights in parallel
    loadAIInsights();
  } catch (error) {
    setStatus('Start the backend: node server.js', true);
  }
}

async function loadAIInsights() {
  try {
    const response = await fetch(`${API_BASE}/api/ai-insights`);
    const data = await response.json();
    if (response.ok && data.aiInsights) {
      renderAIInsights(data.aiInsights, data.source);
    }
  } catch (error) {
    console.log('AI insights not available:', error.message);
  }
}

function renderDashboard(summary) {
  currentSummary = summary;
  renderStats(summary.stats || []);
  renderQueryHints(summary);
  renderAllCharts(summary);
  renderInsightReport(summary.insightReport || []);
  document.getElementById('datasetChip').textContent = `${summary.rows.length} rows � ${summary.columns.length} columns`;
}

function renderSchema(schema) {
  const list = document.getElementById('schemaList');
  list.innerHTML = schema.slice(0, 10).map(col => `
    <div class="schema-row">
      <span>${escapeHtml(col.name)}</span>
      <strong>${col.type}</strong>
    </div>
  `).join('');
  if (schema.length > 10) list.innerHTML += `<div class="schema-row"><span>More</span><strong>+${schema.length - 10}</strong></div>`;
}

function renderStats(stats) {
  document.getElementById('statsGrid').innerHTML = stats.map(s => `
    <div class="card small stat-card ${s.tone || 'cyan'}">
      <h3>${escapeHtml(s.label)}</h3>
      <h2>${escapeHtml(String(s.value))}</h2>
    </div>
  `).join('');
}

function renderQueryHints(summary) {
  const metric = summary.primaryMetric || summary.numericColumns[0];
  const label = summary.labelColumn;
  const examples = ['total rows'];
  if (metric) examples.unshift(`average ${metric}`, `top 10`, `${metric} below 75`);
  if (label) examples.push(`count by ${label}`);
  document.getElementById('queryHints').innerHTML = examples.map(ex =>
    `<button type="button" onclick="useHint('${escapeAttr(ex)}')">${escapeHtml(ex)}</button>`
  ).join('');
}

function useHint(ex) { document.getElementById('q').value = ex; runQuery(); showPage('query'); }

function renderInsightReport(bullets) {
  const list = document.getElementById('insightList');
  list.innerHTML = bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('');
}

function renderAIInsights(insights, source) {
  const container = document.getElementById('aiInsightsContainer');
  if (!container) return;
  
  container.classList.remove('hidden');
  
  const sourceBadge = source === 'gemini' ? 
    '<span class="ai-source-badge">✨ AI-Powered</span>' : 
    '<span class="ai-source-badge">📊 Statistical</span>';
  
  let html = `<div class="ai-insights-header">${sourceBadge}</div>`;
  
  // Summary
  if (insights.summary) {
    html += `<div class="ai-insight-section">
      <h4>📋 Dataset Summary</h4>
      <p>${escapeHtml(insights.summary)}</p>
    </div>`;
  }
  
  // Key Findings
  if (insights.keyFindings && insights.keyFindings.length) {
    html += `<div class="ai-insight-section">
      <h4>🔍 Key Findings</h4>
      <ul>${insights.keyFindings.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
    </div>`;
  }
  
  // Anomalies
  if (insights.anomalies && insights.anomalies.length) {
    html += `<div class="ai-insight-section ai-anomalies">
      <h4>⚠️ Anomalies & Data Quality</h4>
      <ul>${insights.anomalies.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>
    </div>`;
  }
  
  // Recommendations
  if (insights.recommendations && insights.recommendations.length) {
    html += `<div class="ai-insight-section ai-recommendations">
      <h4>💡 Recommendations</h4>
      <ul>${insights.recommendations.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
    </div>`;
  }
  
  container.innerHTML = html;
}

// -- CHARTS --------------------------------------------------------------------

function renderAllCharts(summary) {
  const axisOpts = {
    x: { ticks: { color: CHART_MUTED, font: { size: 11 } }, grid: { color: CHART_GRID } },
    y: { ticks: { color: CHART_MUTED, font: { size: 11 } }, grid: { color: CHART_GRID }, beginAtZero: true }
  };
  const baseOpts = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 900, easing: 'easeOutQuart' },
    plugins: {
      legend: { labels: { color: CHART_TEXT, font: { size: 12, weight: '600' }, padding: 16, usePointStyle: true } },
      tooltip: {
        backgroundColor: 'rgba(10,9,6,0.92)',
        titleColor: '#FFD700',
        bodyColor: '#e8e0d0',
        borderColor: 'rgba(255,210,0,0.3)',
        borderWidth: 1,
        padding: 10
      }
    }
  };

  // ── 1. BAR CHART
  const barWrap = document.getElementById('barWrap');
  if (activeCharts.bar) {
    const bar = summary.barChart || { labels: [], values: [], metric: '', title: '' };
    document.getElementById('barTitle').textContent = bar.title || 'Distribution';
    if (barChartInst) barChartInst.destroy();
    barChartInst = new Chart(document.getElementById('barChart'), {
      type: 'bar',
      data: {
        labels: bar.labels,
        datasets: [{
          label: bar.metric || 'Value',
          data: bar.values,
          borderRadius: 6,
          borderSkipped: false,
          backgroundColor: bar.labels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length] + 'CC'),
          borderColor:     bar.labels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
          borderWidth: 2
        }]
      },
      options: {
        ...baseOpts,
        scales: axisOpts,
        plugins: { ...baseOpts.plugins, legend: { display: false } }
      }
    });
    barWrap.classList.remove('chart-hidden');
  } else {
    barWrap.classList.add('chart-hidden');
  }

  // ── 2. DOUGHNUT CHART
  const doughnutWrap = document.getElementById('doughnutWrap');
  if (activeCharts.doughnut) {
    const pie = summary.pieChart || { labels: [], values: [], title: '' };
    document.getElementById('doughnutTitle').textContent = pie.title || 'Category Split';
    if (doughnutChartInst) doughnutChartInst.destroy();
    doughnutChartInst = new Chart(document.getElementById('doughnutChart'), {
      type: 'doughnut',
      data: {
        labels: pie.labels,
        datasets: [{
          data: pie.values,
          backgroundColor: CHART_COLORS.map(c => c + 'CC'),
          borderColor: CHART_COLORS,
          borderWidth: 2,
          hoverOffset: 18
        }]
      },
      options: {
        ...baseOpts,
        cutout: '58%',
        plugins: {
          ...baseOpts.plugins,
          legend: { position: 'right', labels: { color: CHART_TEXT, font: { size: 11 }, padding: 12, usePointStyle: true, boxWidth: 10 } }
        }
      }
    });
    doughnutWrap.classList.remove('chart-hidden');
  } else {
    doughnutWrap.classList.add('chart-hidden');
  }

  // ── 3. LINE CHART
  const lineWrap = document.getElementById('lineWrap');
  const line = summary.lineChart;
  if (activeCharts.line && line && line.labels.length) {
    document.getElementById('lineTitle').textContent = line.title || 'Trend Over Index';
    if (lineChartInst) lineChartInst.destroy();
    lineChartInst = new Chart(document.getElementById('lineChart'), {
      type: 'line',
      data: {
        labels: line.labels,
        datasets: [{
          label: line.metric || 'Value',
          data: line.values,
          borderColor: LINE_COLOR,
          backgroundColor: LINE_FILL,
          pointBackgroundColor: LINE_COLOR,
          pointBorderColor: '#1a1500',
          pointBorderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 5,
          pointHoverRadius: 7
        }]
      },
      options: { ...baseOpts, scales: axisOpts }
    });
    lineWrap.classList.remove('chart-hidden');
  } else { lineWrap.classList.add('chart-hidden'); }

  // ── 4. HORIZONTAL BAR CHART
  const hbarWrap = document.getElementById('hbarWrap');
  const hbar = summary.hBarChart;
  if (activeCharts.hbar && hbar && hbar.labels.length) {
    document.getElementById('hbarTitle').textContent = hbar.title || 'Top Ranking';
    if (hbarChartInst) hbarChartInst.destroy();
    hbarChartInst = new Chart(document.getElementById('hbarChart'), {
      type: 'bar',
      data: {
        labels: hbar.labels,
        datasets: [{
          label: hbar.metric || 'Count',
          data: hbar.values,
          backgroundColor: hbar.labels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length] + 'CC'),
          borderColor:     hbar.labels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
          borderWidth: 2,
          borderRadius: 4
        }]
      },
      options: {
        ...baseOpts,
        indexAxis: 'y',
        scales: {
          x: axisOpts.x,
          y: { ticks: { color: CHART_TEXT, font: { size: 11 } }, grid: { color: CHART_GRID } }
        },
        plugins: { ...baseOpts.plugins, legend: { display: false } }
      }
    });
    hbarWrap.classList.remove('chart-hidden');
  } else { hbarWrap.classList.add('chart-hidden'); }
}

// -- HELPERS -------------------------------------------------------------------

function setStatus(msg, isError = false) {
  const el = document.getElementById('uploadStatus');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function formatCell(value) {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'number') return Number(value.toFixed(2)).toLocaleString();
  return String(value);
}

function escapeHtml(v) {
  return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function escapeAttr(v) { return escapeHtml(v).replace(/`/g, '&#096;'); }

// ── CHART SELECTION CONTROLS ───────────────────────────────────

function selectAllCharts() {
  document.querySelectorAll('[data-chart-type]').forEach(cb => cb.checked = true);
  activeCharts = { bar: true, doughnut: true, line: true, hbar: true };
  updateChartOptions();
}

function deselectAllCharts() {
  document.querySelectorAll('[data-chart-type]').forEach(cb => cb.checked = false);
  activeCharts = { bar: false, doughnut: false, line: false, hbar: false };
  updateChartOptions();
}

function applyChartSelection() {
  // Read checkbox states
  document.querySelectorAll('[data-chart-type]').forEach(cb => {
    const type = cb.getAttribute('data-chart-type');
    activeCharts[type] = cb.checked;
  });
  
  // Re-render charts with new selection
  if (currentSummary) {
    renderAllCharts(currentSummary);
  }
  
  updateChartOptions();
}

function updateChartOptions() {
  // Update checkbox option styling
  document.querySelectorAll('.chart-option').forEach(opt => {
    const chartType = opt.getAttribute('data-chart');
    const cb = opt.querySelector('input[type="checkbox"]');
    opt.classList.toggle('selected', cb.checked);
  });
  
  // Show count of active charts
  const activeCount = Object.values(activeCharts).filter(v => v).length;
  const badge = document.querySelector('.selector-badge');
  if (badge) {
    badge.textContent = activeCount === 4 ? 'All' : `${activeCount} Active`;
  }
}

// Initialize chart selection UI on page load
function initChartSelector() {
  updateChartOptions();
  
  // Add change listeners to checkboxes
  document.querySelectorAll('[data-chart-type]').forEach(cb => {
    cb.addEventListener('change', () => {
      applyChartSelection();
    });
  });
}


function renderChartRecommendations(recommendations) {
  let card = document.getElementById('chartRecommendationsCard');
  if (!card) {
    card = document.createElement('div');
    card.id = 'chartRecommendationsCard';
    card.className = 'card chart-recommendations-card';
    card.innerHTML = '<span class="eyebrow">? AI-Powered Chart Insights</span><div id="chartRecContent"></div>';
    const insightReport = document.getElementById('insightReport');
    insightReport.parentNode.insertBefore(card, insightReport);
  }
  
  const content = document.getElementById('chartRecContent');
  let html = '';
  
  if (recommendations.bestVisualization) {
    html += '<div class="rec-section rec-best"><h4>?? Recommended Approach</h4><p>' + escapeHtml(recommendations.bestVisualization) + '</p></div>';
  }
  
  if (recommendations.priority.length > 0) {
    html += '<div class="rec-section rec-priority"><h4>?? Priority Charts</h4><ul>' + recommendations.priority.map(r => '<li><strong>' + r.title + '</strong> � ' + escapeHtml(r.reason) + '</li>').join('') + '</ul></div>';
  }
  
  if (recommendations.insights.length > 0) {
    html += '<div class="rec-section rec-insights"><h4>?? Data Insights</h4><ul>' + recommendations.insights.map(i => '<li>' + escapeHtml(i) + '</li>').join('') + '</ul></div>';
  }
  
  content.innerHTML = html;
}
