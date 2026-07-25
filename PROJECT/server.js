const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const https = require('https');

// Load Gemini API Key and Model from environment or .env file
let GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
let GEMINI_MODEL = process.env.MODEL || 'gemma-4-31b-it';
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const keyMatch = envContent.match(/^GEMINI_API_KEY\s*=\s*["']?([^"'\n\r]+)["']?$/m);
    const modelMatch = envContent.match(/^MODEL\s*=\s*["']?([^"'\n\r]+)["']?$/m);
    if (keyMatch) GEMINI_API_KEY = keyMatch[1];
    if (modelMatch) GEMINI_MODEL = modelMatch[1];
  }
} catch (e) { /* ignore */ }

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

const PG_CONFIG = {
  host: process.env.PG_HOST || '127.0.0.1',
  port: Number(process.env.PG_PORT) || 5432,
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
  database: process.env.PG_DATABASE || 'insight'
};

const sampleRows = [
  { Name: 'Arun',  Department: 'CSE', CGPA: 8.5, Attendance: 88, Placement: 'Eligible' },
  { Name: 'Kavi',  Department: 'ECE', CGPA: 7.2, Attendance: 74, Placement: 'Not Eligible' },
  { Name: 'Meena', Department: 'CSE', CGPA: 9.1, Attendance: 96, Placement: 'Eligible' },
  { Name: 'John',  Department: 'IT',  CGPA: 6.8, Attendance: 69, Placement: 'Not Eligible' },
  { Name: 'Priya', Department: 'ECE', CGPA: 8.0, Attendance: 82, Placement: 'Eligible' },
  { Name: 'Ravi',  Department: 'CSE', CGPA: 7.6, Attendance: 78, Placement: 'Eligible' }
];

let pool;

async function start() {
  pool = new Pool(PG_CONFIG);
  pool.on('error', err => console.error('PG pool error:', err.message));
  await initDatabase();

  const server = http.createServer(async (req, res) => {
    try {
      // CORS pre-flight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
      }
      if (req.url === '/api/summary' && req.method === 'GET') {
        const rows = await loadRows();
        return sendJson(res, 200, buildSummary(rows));
      }
      if (req.url === '/api/ai-insights' && req.method === 'GET') {
        const rows = await loadRows();
        if (!rows.length) return sendJson(res, 400, { error: 'No data loaded' });
        const summary = buildSummary(rows);
        const insights = await generateAIInsights(summary, rows);
        return sendJson(res, 200, insights);
      }
      if (req.url === '/api/upload' && req.method === 'POST') {
        const body = await readJson(req);
        const cleaned = cleanRows(body.rows || []);
        if (!cleaned.rows.length) return sendJson(res, 400, { error: 'No valid rows found.' });
        await saveRows(cleaned.rows);
        const rows = await loadRows();
        return sendJson(res, 200, { count: rows.length, cleaning: cleaned.report, summary: buildSummary(rows) });
      }
      if (req.url === '/api/query' && req.method === 'POST') {
        const body = await readJson(req);
        const rows = await loadRows();
        const query = String(body.query || '');
        
        if (!rows.length) {
          return sendJson(res, 400, { error: 'No data loaded. Please upload a CSV first.' });
        }
        
        // Try Gemini API first (if API key is available)
        if (GEMINI_API_KEY) {
          try {
            const summary = buildSummary(rows);
            const geminiSQL = await convertPromptToSQL(query, summary.schema, rows);
            
            if (geminiSQL) {
              // Basic SQL injection guard
              const sqlUpper = geminiSQL.trim().toUpperCase();
              const isDangerous = /^(DROP|DELETE|INSERT|UPDATE|ALTER|TRUNCATE|CREATE|GRANT|REVOKE)/.test(sqlUpper);
              if (isDangerous) throw new Error('Unsafe SQL rejected');

              // Execute Gemini-generated SQL
              const result = await pool.query(geminiSQL);
              const resultRows = result.rows;
              
              if (resultRows.length > 0) {
                const columns = Object.keys(resultRows[0]);
                const isMetric = columns.length === 1 && typeof resultRows[0][columns[0]] === 'number';
                
                if (isMetric) {
                  return sendJson(res, 200, {
                    type: 'metric',
                    title: query,
                    value: resultRows[0][columns[0]],
                    insight: `Generated via Gemini AI: ${geminiSQL}`
                  });
                } else {
                  return sendJson(res, 200, {
                    type: 'list',
                    title: query,
                    rows: resultRows.slice(0, 50),
                    columns: columns,
                    insight: `Generated via Gemini AI: ${geminiSQL}`
                  });
                }
              } else {
                // No results from SQL
                return sendJson(res, 200, {
                  type: 'metric',
                  title: 'No Results',
                  value: 0,
                  insight: `Query returned 0 rows. SQL: ${geminiSQL}`
                });
              }
            }
          } catch (sqlError) {
            console.log('Gemini SQL failed:', sqlError.message);
            // Fall through to local parsing
          }
        }
        
        // Fallback to local query parsing
        try {
          const result = answerQuery(query, rows);
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, 500, { 
            error: 'Query processing failed',
            insight: err.message 
          });
        }
      }
      if (req.url === '/api/database' && req.method === 'GET') {
        const result = await pool.query('SELECT COUNT(*) AS count FROM dataset_rows');
        return sendJson(res, 200, { database: `${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database}`, rows: result.rows[0] });
      }
      if (req.url === '/api/ai-status' && req.method === 'GET') {
        return sendJson(res, 200, { geminiEnabled: !!GEMINI_API_KEY, model: GEMINI_MODEL });
      }
      return serveStatic(req, res);
    } catch (error) {
      return sendJson(res, 500, { error: error.message || 'Server error' });
    }
  });

  server.listen(PORT, () => {
    console.log(`Insight Query AI running at http://127.0.0.1:${PORT}`);
    console.log(`PostgreSQL connected: ${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database}`);
  });
}

start().catch(error => { console.error('Failed to start:', error); process.exit(1); });

// -- DATABASE ------------------------------------------------------------------

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS dataset_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS dataset_rows (id SERIAL PRIMARY KEY, row_json TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const r = await client.query('SELECT COUNT(*) AS count FROM dataset_rows');
    if (Number(r.rows[0].count) === 0) await saveRows(sampleRows);
  } finally { client.release(); }
}

async function saveRows(rows) {
  const columns = getColumns(rows);
  const numericColumns = getNumericColumns(rows, columns);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM dataset_rows');
    await client.query('DELETE FROM dataset_meta');
    for (const row of rows) await client.query('INSERT INTO dataset_rows (row_json) VALUES ($1)', [JSON.stringify(row)]);
    await client.query('INSERT INTO dataset_meta (key,value) VALUES ($1,$2)', ['columns', JSON.stringify(columns)]);
    await client.query('INSERT INTO dataset_meta (key,value) VALUES ($1,$2)', ['numericColumns', JSON.stringify(numericColumns)]);
    await client.query('INSERT INTO dataset_meta (key,value) VALUES ($1,$2)', ['updatedAt', new Date().toISOString()]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function loadRows() {
  const result = await pool.query('SELECT row_json FROM dataset_rows ORDER BY id ASC');
  return result.rows.map(r => JSON.parse(r.row_json));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 5_000_000) { req.destroy(); reject(new Error('Body too large')); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// -- MODULE 1: DATA CLEANING ---------------------------------------------------

function cleanRows(inputRows) {
  const seen = new Set();
  let duplicatesRemoved = 0;
  let missingValues = 0;
  const missingDetail = {};
  const duplicateRows = [];
  const invalidValues = [];
  const outliers = [];

  const cleanedRows = inputRows.reduce((acc, row, rowIndex) => {
    const cleanRow = {};
    let hasValue = false;

    Object.entries(row || {}).forEach(([rawKey, rawValue]) => {
      const key = normalizeColumn(rawKey);
      const value = parseCell(rawValue);
      if (!missingDetail[key]) missingDetail[key] = 0;
      if (value === '') { missingValues++; missingDetail[key]++; }
      if (value !== '') hasValue = true;
      if (key) cleanRow[key] = value;
    });

    if (!hasValue || !Object.keys(cleanRow).length) return acc;

    const dupKey = JSON.stringify(cleanRow).toLowerCase();
    if (seen.has(dupKey)) { duplicatesRemoved++; duplicateRows.push(cleanRow); return acc; }
    seen.add(dupKey);
    acc.push(cleanRow);
    return acc;
  }, []);

  const missingDetailArray = Object.entries(missingDetail)
    .filter(([, c]) => c > 0)
    .map(([column, count]) => ({ column, count }));

  // Advanced validation & statistics
  const validationReport = validateData(cleanedRows, inputRows.length);

  return {
    rows: cleanedRows,
    report: { 
      missingValues, 
      duplicatesRemoved, 
      missingDetail: missingDetailArray, 
      duplicateRows: duplicateRows.slice(0, 20),
      validation: validationReport
    }
  };
}

// Advanced Data Validation & Quality Scoring
function validateData(rows, originalCount) {
  const report = {
    qualityScore: 0,
    totalRecords: rows.length,
    originalRecords: originalCount,
    completeness: 0,
    consistency: 0,
    accuracy: 0,
    columnAnalysis: [],
    outliers: [],
    invalidValues: [],
    suggestions: []
  };

  if (!rows.length) return report;

  const columns = Object.keys(rows[0]);
  const totalCells = rows.length * columns.length;
  let filledCells = 0;
  let consistentCells = 0;
  let accurateCells = 0;

  columns.forEach(col => {
    const colAnalysis = {
      name: col,
      type: 'unknown',
      total: rows.length,
      filled: 0,
      missing: 0,
      unique: 0,
      invalid: 0,
      outliers: 0,
      stats: {}
    };

    const values = rows.map(r => r[col]);
    const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
    const numericValues = nonEmpty.filter(v => typeof v === 'number');
    const textValues = nonEmpty.filter(v => typeof v === 'string');

    colAnalysis.filled = nonEmpty.length;
    colAnalysis.missing = rows.length - nonEmpty.length;
    colAnalysis.unique = new Set(nonEmpty.map(String)).size;
    filledCells += nonEmpty.length;

    // Determine column type
    const numericRatio = numericValues.length / nonEmpty.length;
    colAnalysis.type = numericRatio > 0.8 ? 'numeric' : (textValues.length > 0.8 ? 'text' : 'mixed');

    // Numeric column analysis
    if (colAnalysis.type === 'numeric' && numericValues.length > 0) {
      const stats = calculateNumericStats(numericValues);
      colAnalysis.stats = stats;

      // Check for outliers (values beyond 3 standard deviations)
      const outlierThreshold = 3 * stats.stdDev;
      const outlierValues = numericValues.filter(v => Math.abs(v - stats.mean) > outlierThreshold);
      colAnalysis.outliers = outlierValues.length;
      report.outliers.push(...outlierValues.map(v => ({
        column: col,
        value: v,
        deviation: ((v - stats.mean) / stats.stdDev).toFixed(2) + 'σ'
      })));

      // Check for invalid values (negative percentages, impossible values)
      const invalidChecks = checkInvalidValues(numericValues, col);
      colAnalysis.invalid = invalidChecks.length;
      report.invalidValues.push(...invalidChecks);

      accurateCells += (numericValues.length - colAnalysis.invalid);
    }

    // Text column analysis
    if (colAnalysis.type === 'text') {
      // Check for inconsistent casing
      const caseInconsistencies = detectCaseInconsistencies(textValues);
      colAnalysis.invalid = caseInconsistencies.length;
      if (caseInconsistencies.length > 0) {
        report.suggestions.push(`Standardize casing in "${col}" column (${caseInconsistencies.length} inconsistencies)`);
      }
      accurateCells += (textValues.length - colAnalysis.invalid);
      consistentCells += textValues.length;
    } else if (colAnalysis.type === 'numeric') {
      consistentCells += numericValues.length;
    } else {
      consistentCells += Math.max(numericValues.length, textValues.length);
      accurateCells += Math.max(numericValues.length, textValues.length);
    }

    report.columnAnalysis.push(colAnalysis);
  });

  // Calculate quality scores (0-100)
  report.completeness = totalCells > 0 ? Math.round((filledCells / totalCells) * 100) : 0;
  report.consistency = filledCells > 0 ? Math.round((consistentCells / filledCells) * 100) : 0;
  report.accuracy = filledCells > 0 ? Math.round((accurateCells / filledCells) * 100) : 0;

  // Overall quality score (weighted average)
  report.qualityScore = Math.round(
    (report.completeness * 0.4) + 
    (report.consistency * 0.3) + 
    (report.accuracy * 0.3)
  );

  // Generate smart suggestions
  if (report.completeness < 90) {
    report.suggestions.unshift('Consider filling missing values or removing incomplete records');
  }
  if (report.outliers.length > 0) {
    report.suggestions.push(`Review ${report.outliers.length} detected outliers for data entry errors`);
  }
  if (report.invalidValues.length > 0) {
    report.suggestions.push(`Fix ${report.invalidValues.length} invalid values before analysis`);
  }
  if (rows.length < 10) {
    report.suggestions.push('Dataset is small - consider collecting more data for reliable insights');
  }

  return report;
}

function calculateNumericStats(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sorted = [...values].sort((a, b) => a - b);
  const median = n % 2 === 0 
    ? (sorted[n/2 - 1] + sorted[n/2]) / 2 
    : sorted[Math.floor(n/2)];
  const min = sorted[0];
  const max = sorted[n - 1];
  const range = max - min;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);
  const q1 = sorted[Math.floor(n * 0.25)];
  const q3 = sorted[Math.floor(n * 0.75)];
  const iqr = q3 - q1;

  return {
    mean: Number(mean.toFixed(2)),
    median: Number(median.toFixed(2)),
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    range: Number(range.toFixed(2)),
    stdDev: Number(stdDev.toFixed(2)),
    variance: Number(variance.toFixed(2)),
    q1: Number(q1.toFixed(2)),
    q3: Number(q3.toFixed(2)),
    iqr: Number(iqr.toFixed(2))
  };
}

function checkInvalidValues(values, columnName) {
  const invalid = [];
  const colLower = columnName.toLowerCase();

  values.forEach((v, idx) => {
    // Percentage columns (0-100)
    if (colLower.includes('attendance') || colLower.includes('percent')) {
      if (v < 0 || v > 100) {
        invalid.push({ column: columnName, value: v, issue: `Invalid percentage: ${v}% (must be 0-100)` });
      }
    }

    // CGPA/GPA (typically 0-10 or 0-4)
    if (colLower.includes('cgpa') || colLower.includes('gpa') || colLower.includes('grade')) {
      if (v < 0 || v > 10) {
        invalid.push({ column: columnName, value: v, issue: `Invalid CGPA/GPA: ${v} (must be 0-10)` });
      } else if (v > 4 && v <= 10) {
        // Might be 10-point scale, just note it
      }
    }

    // Age (realistic range)
    if (colLower.includes('age')) {
      if (v < 0 || v > 120) {
        invalid.push({ column: columnName, value: v, issue: `Invalid age: ${v} years` });
      }
    }

    // Negative values where they shouldn't exist
    if (v < 0 && !colLower.includes('change') && !colLower.includes('difference')) {
      if (!colLower.includes('cgpa') && !colLower.includes('gpa') && !colLower.includes('attendance')) {
        // Already checked above
      }
    }
  });

  return invalid;
}

function detectCaseInconsistencies(values) {
  const inconsistencies = [];
  const valueMap = {};

  values.forEach(v => {
    const normalized = v.trim().toLowerCase();
    if (!valueMap[normalized]) {
      valueMap[normalized] = [];
    }
    valueMap[normalized].push(v);
  });

  Object.entries(valueMap).forEach(([normalized, variations]) => {
    if (variations.length > 1) {
      const uniqueVariations = [...new Set(variations)];
      if (uniqueVariations.length > 1) {
        inconsistencies.push({
          normalized,
          variations: uniqueVariations,
          count: variations.length
        });
      }
    }
  });

  return inconsistencies;
}

// AI-Powered Chart Recommendations
function getAIChartRecommendations(rows, columns, numericColumns, textColumns, labelColumn, primaryMetric) {
  const recommendations = {
    priority: [],
    insights: [],
    bestVisualization: ''
  };

  // Analyze data characteristics
  const totalRows = rows.length;
  const uniqueCategories = labelColumn ? new Set(rows.map(r => r[labelColumn])).size : 0;
  const numericRatio = numericColumns.length / columns.length;

  // Determine best chart types based on data
  if (uniqueCategories >= 2 && uniqueCategories <= 15) {
    recommendations.priority.push({
      type: 'bar',
      reason: `Compare ${primaryMetric} across ${uniqueCategories} ${labelColumn} categories`,
      title: `Average ${primaryMetric} by ${labelColumn}`,
      priority: 1
    });
  }

  if (uniqueCategories >= 2 && uniqueCategories <= 8) {
    recommendations.priority.push({
      type: 'pie',
      reason: `Show distribution of ${totalRows} records across ${uniqueCategories} ${labelColumn}`,  
      title: `Distribution by ${labelColumn}`,
      priority: 2
    });
  }

  if (numericColumns.length >= 2) {
    recommendations.priority.push({
      type: 'comparison',
      reason: `Compare multiple metrics: ${numericColumns.slice(0, 3).join(', ')}`,
      title: 'Multi-Metric Analysis',
      priority: 3
    });
  }

  if (totalRows >= 10) {
    recommendations.priority.push({
      type: 'ranking',
      reason: `Identify top performers by ${primaryMetric}`,
      title: `Top 10 by ${primaryMetric}`,
      priority: 4
    });
  }

  // Generate context-aware insights
  if (labelColumn && primaryMetric) {
    const groups = {};
    rows.forEach(row => {
      const key = String(row[labelColumn]);
      if (!groups[key]) groups[key] = [];
      const val = Number(row[primaryMetric]);
      if (!isNaN(val)) groups[key].push(val);
    });

    const averages = Object.entries(groups).map(([key, values]) => ({
      category: key,
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      count: values.length
    })).sort((a, b) => b.avg - a.avg);

    if (averages.length > 0) {
      const best = averages[0];
      const worst = averages[averages.length - 1];
      
      recommendations.insights.push(
        `🏆 ${best.category} has highest average ${primaryMetric} (${best.avg.toFixed(2)})`
      );
      
      if (averages.length > 1) {
        recommendations.insights.push(
          `📉 ${worst.category} has lowest average ${primaryMetric} (${worst.avg.toFixed(2)})`
        );
        
        const gap = (best.avg - worst.avg).toFixed(2);
        recommendations.insights.push(
          `📊 Gap between best and worst: ${gap} points`
        );
      }
    }
  }

  // Determine best visualization
  if (uniqueCategories >= 3 && uniqueCategories <= 10) {
    recommendations.bestVisualization = 'Bar chart for comparison + Pie chart for distribution';
  } else if (numericColumns.length >= 3) {
    recommendations.bestVisualization = 'Multiple charts to show different metric relationships';
  } else {
    recommendations.bestVisualization = 'Focus on key metric trends and rankings';
  }

  return recommendations;
}

function parseCell(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const numeric = Number(text.replace(/,/g, ''));
  return Number.isFinite(numeric) && /^-?[\d,.]+$/.test(text) ? numeric : text;
}

function normalizeColumn(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').replace(/^./, c => c.toUpperCase());
}

// -- MODULE 2: QUERY ENGINE ----------------------------------------------------

// Convert natural language to SQL using Gemini API
async function convertPromptToSQL(prompt, schema, sampleData) {
  if (!GEMINI_API_KEY) {
    return null; // Fallback to local parsing
  }

  const systemPrompt = `You are a SQL expert. Convert the user's natural language query into a PostgreSQL SQL query.

Database Schema (column names and types):
${schema.map(col => `- ${col.name} (${col.type})`).join('\n')}

IMPORTANT - Column Name Mapping:
Users may use abbreviations or synonyms. You MUST map them to the EXACT column names above:
- "dept" or "department" or "div" → use the exact Department column name from schema
- "name" or "student" or "employee" → use the exact Name column name from schema  
- "cgpa" or "gpa" or "grade" or "score" → use the exact CGPA column name from schema
- "attendance" or "present" or "presence" → use the exact Attendance column name from schema
- "placement" or "job" or "eligible" → use the exact Placement column name from schema
- ALWAYS use the EXACT column names from the schema, never invent new ones

Sample Data (first 3 rows to understand the structure):
${JSON.stringify(sampleData.slice(0, 3), null, 2)}

Rules:
1. Return ONLY the SQL query, nothing else
2. Use standard PostgreSQL syntax
3. For "count" queries: SELECT COUNT(*)
4. For "average" queries: SELECT AVG(column_name)
5. For "top N" queries: SELECT ... ORDER BY ... DESC LIMIT N
6. For filters: SELECT * FROM dataset WHERE condition
7. For group by: SELECT column, COUNT(*) GROUP BY column
8. ALWAYS use the EXACT column names from the schema section above
9. Return "INVALID" if the query cannot be converted
10. When user says "dept", "department", or similar → use the Department column
11. When user says "by [something]" → that's a GROUP BY operation

Examples:
- "count by dept" → SELECT "Department", COUNT(*) FROM dataset GROUP BY "Department" ORDER BY COUNT(*) DESC
- "average cgpa" → SELECT AVG("CGPA") FROM dataset
- "top 10 by attendance" → SELECT * FROM dataset ORDER BY "Attendance" DESC LIMIT 10

User Query: ${prompt}

SQL Query:`;

  return new Promise((resolve) => {
    const postData = JSON.stringify({
      contents: [{
        parts: [{
          text: systemPrompt
        }]
      }]
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          const sql = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (sql && sql !== 'INVALID') {
            resolve(sql);
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => resolve(null));
    req.write(postData);
    req.end();
  });
}

// Generate AI-powered data insights
async function generateAIInsights(summary, rows) {
  if (!GEMINI_API_KEY) {
    return generateLocalInsights(summary, rows);
  }

  const sampleData = rows.slice(0, 5);
  const numericStats = summary.numericColumns.map(col => {
    const values = rows.map(r => r[col]).filter(v => typeof v === 'number');
    if (!values.length) return null;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { column: col, avg: avg.toFixed(2), min, max, count: values.length };
  }).filter(Boolean);

  const analysisPrompt = `You are a data analyst. Analyze this dataset and provide meaningful insights.

Dataset Overview:
- Total Records: ${rows.length}
- Columns: ${summary.columns.join(', ')}
- Numeric Columns: ${summary.numericColumns.join(', ')}
- Label Column: ${summary.labelColumn || 'N/A'}

Column Statistics:
${numericStats.map(s => `- ${s.column}: Avg=${s.avg}, Min=${s.min}, Max=${s.max}, Count=${s.count}`).join('\n')}

Sample Data (first 5 rows):
${JSON.stringify(sampleData, null, 2)}

Provide insights in this exact JSON format (no markdown, no code blocks):
{
  "keyFindings": [
    "Finding 1: Specific observation with numbers",
    "Finding 2: Another observation",
    "Finding 3: Pattern or trend"
  ],
  "recommendations": [
    "Actionable recommendation 1",
    "Actionable recommendation 2"
  ],
  "anomalies": [
    "Any unusual patterns or outliers"
  ],
  "summary": "One paragraph summary of the dataset"
}

Rules:
1. Be specific with numbers and percentages
2. Focus on actionable insights
3. Identify patterns and trends
4. Point out any data quality issues
5. Keep findings concise (1-2 sentences each)
6. Return ONLY valid JSON, nothing else`;

  return new Promise((resolve) => {
    const postData = JSON.stringify({
      contents: [{
        parts: [{ text: analysisPrompt }]
      }]
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (text) {
            // Try to parse JSON from the response
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              try {
                const insights = JSON.parse(jsonMatch[0]);
                resolve({
                  aiInsights: insights,
                  source: 'gemini'
                });
              } catch (e) {
                resolve({ aiInsights: generateLocalInsights(summary, rows), source: 'local' });
              }
            } else {
              resolve({ aiInsights: generateLocalInsights(summary, rows), source: 'local' });
            }
          } else {
            resolve({ aiInsights: generateLocalInsights(summary, rows), source: 'local' });
          }
        } catch (e) {
          resolve({ aiInsights: generateLocalInsights(summary, rows), source: 'local' });
        }
      });
    });

    req.on('error', () => resolve({ aiInsights: generateLocalInsights(summary, rows), source: 'local' }));
    req.setTimeout(8000, () => resolve({ aiInsights: generateLocalInsights(summary, rows), source: 'local' }));
    req.write(postData);
    req.end();
  });
}

function generateLocalInsights(summary, rows) {
  const insights = {
    keyFindings: [],
    recommendations: [],
    anomalies: [],
    summary: ''
  };

  // Basic statistical insights
  if (summary.numericColumns.length > 0) {
    const primaryMetric = summary.primaryMetric;
    if (primaryMetric) {
      const values = rows.map(r => r[primaryMetric]).filter(v => typeof v === 'number');
      if (values.length) {
        const avg = (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2);
        const min = Math.min(...values);
        const max = Math.max(...values);
        insights.keyFindings.push(`Average ${primaryMetric}: ${avg} (range: ${min} - ${max})`);
        
        const highPerformers = values.filter(v => v > parseFloat(avg)).length;
        insights.keyFindings.push(`${highPerformers} out of ${values.length} records (${((highPerformers/values.length)*100).toFixed(1)}%) are above average`);
      }
    }
  }

  // Distribution insights
  if (summary.labelColumn) {
    const counts = {};
    rows.forEach(r => {
      const val = r[summary.labelColumn] || 'Unknown';
      counts[val] = (counts[val] || 0) + 1;
    });
    
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) {
      insights.keyFindings.push(`Most common ${summary.labelColumn}: ${sorted[0][0]} (${sorted[0][1]} records, ${((sorted[0][1]/rows.length)*100).toFixed(1)}%)`);
    }
    if (sorted.length > 1) {
      insights.keyFindings.push(`${sorted.length} distinct ${summary.labelColumn} categories found`);
    }
  }

  // Data quality insights
  if (summary.missingValues > 0) {
    insights.anomalies.push(`${summary.missingValues} missing values detected in the dataset`);
  }

  // Recommendations
  if (summary.numericColumns.length > 0) {
    insights.recommendations.push(`Monitor ${summary.primaryMetric || 'key metrics'} regularly to track performance`);
  }
  if (summary.labelColumn) {
    insights.recommendations.push(`Analyze trends across different ${summary.labelColumn} categories`);
  }
  insights.recommendations.push('Consider segmenting data for deeper analysis');

  insights.summary = `Dataset contains ${rows.length} records with ${summary.columns.length} columns (${summary.numericColumns.length} numeric, ${summary.columns.length - summary.numericColumns.length} categorical). ${summary.labelColumn ? `Primary grouping by ${summary.labelColumn}.` : ''} ${summary.primaryMetric ? `Key metric: ${summary.primaryMetric}.` : ''}`;

  return insights;
}

function answerQuery(query, currentRows) {
  const summary = buildSummary(currentRows);
  const normalized = query.toLowerCase().trim();
  const metricColumn = findColumnInQuery(normalized, summary.numericColumns) || summary.primaryMetric;
  const anyColumn = findColumnInQuery(normalized, summary.columns);

  // SORT - Check early to prevent it from being caught by other patterns
  if ((normalized.includes('sort') || normalized.includes('order'))) {
    const sortCol = metricColumn || anyColumn || summary.primaryMetric;
    if (sortCol) {
      const dir = normalized.includes('desc') || normalized.includes('high') || normalized.includes('descending') ? 'desc' : 'asc';
      return { ...sortedList(`Sorted by ${sortCol}`, currentRows, summary.columns, sortCol, dir, 50),
        insight: `Records sorted by ${sortCol} in ${dir === 'desc' ? 'descending' : 'ascending'} order.` };
    }
  }

  // GROUP BY - Enhanced detection
  const isGroup = normalized.includes('group by') || normalized.includes('wise') ||
                  normalized.includes('count by') || normalized.includes('department-wise') ||
                  normalized.includes('department wise') || normalized.includes('per ') ||
                  normalized.includes('by department') || normalized.includes('by dept') ||
                  (normalized.includes('by ') && normalized.includes('count'));
  if (isGroup) {
    const groupCol = anyColumn || summary.labelColumn;
    if (groupCol) {
      const groups = groupByColumn(currentRows, groupCol, metricColumn);
      return {
        type: 'group',
        title: metricColumn ? `Avg ${metricColumn} by ${groupCol}` : `Count by ${groupCol}`,
        groupColumn: groupCol, aggColumn: metricColumn || null,
        rows: groups,
        columns: metricColumn ? [groupCol, 'Count', `Avg ${metricColumn}`] : [groupCol, 'Count'],
        insight: `Grouped ${currentRows.length} records into ${groups.length} ${groupCol} categories.`
      };
    }
  }

  // AGGREGATE - Average, Sum, Max, Min (before filters)
  if ((normalized.includes('average') || normalized.includes('avg') || normalized.includes('mean')) && metricColumn) {
    const avg = averageOf(getNumbers(currentRows, metricColumn));
    return { type: 'metric', title: `Average ${metricColumn}`, value: formatNumber(avg),
      insight: `Average ${metricColumn} across ${currentRows.length} records: ${formatNumber(avg)}.` };
  }

  if (normalized.includes('sum') && metricColumn) {
    const s = sumOf(getNumbers(currentRows, metricColumn));
    return { type: 'metric', title: `Sum of ${metricColumn}`, value: formatNumber(s),
      insight: `Total sum of ${metricColumn}: ${formatNumber(s)}.` };
  }

  if ((normalized.includes('max') || normalized.includes('highest') || normalized.includes('maximum')) && metricColumn) {
    const vals = getNumbers(currentRows, metricColumn);
    const maxVal = Math.max(...vals);
    const maxRow = currentRows.find(r => r[metricColumn] === maxVal);
    const label = maxRow ? (maxRow[summary.labelColumn] || '') : '';
    return { type: 'metric', title: `Max ${metricColumn}`, value: formatNumber(maxVal),
      insight: `Highest ${metricColumn}: ${formatNumber(maxVal)}${label ? ` (${label})` : ''}.` };
  }

  if ((normalized.includes('min') || normalized.includes('lowest') || normalized.includes('minimum')) && metricColumn) {
    const vals = getNumbers(currentRows, metricColumn);
    const minVal = Math.min(...vals);
    const minRow = currentRows.find(r => r[metricColumn] === minVal);
    const label = minRow ? (minRow[summary.labelColumn] || '') : '';
    return { type: 'metric', title: `Min ${metricColumn}`, value: formatNumber(minVal),
      insight: `Lowest ${metricColumn}: ${formatNumber(minVal)}${label ? ` (${label})` : ''}.` };
  }

  // FILTERS - Word-based (below, above, less than, etc.)
  const wordFilter = parseWordFilter(normalized, summary.columns);
  if (wordFilter) {
    const filtered = currentRows.filter(row => compareValue(row[wordFilter.column], wordFilter.operator, wordFilter.value));
    return {
      type: 'list', title: `${wordFilter.column} ${wordFilter.label} ${wordFilter.rawValue}`,
      rows: filtered.slice(0, 50), columns: summary.columns,
      insight: `Found ${filtered.length} record${filtered.length !== 1 ? 's' : ''} where ${wordFilter.column} ${wordFilter.label} ${wordFilter.rawValue}.`
    };
  }

  // FILTERS - Symbol-based (<=, >=, <, >, =)
  const filter = parseFilter(normalized, summary.columns);
  if (filter) {
    const filtered = currentRows.filter(row => compareValue(row[filter.column], filter.operator, filter.value));
    return {
      type: 'list', title: `${filter.column} ${filter.operator} ${filter.rawValue}`,
      rows: filtered.slice(0, 50), columns: summary.columns,
      insight: `Found ${filtered.length} record${filtered.length !== 1 ? 's' : ''}.`
    };
  }

  // COUNT
  if (normalized.includes('count') || normalized.includes('total') || normalized.includes('how many')) {
    return { type: 'metric', title: 'Total Row Count', value: currentRows.length,
      insight: `Dataset has ${currentRows.length} records across ${summary.columns.length} columns.` };
  }

  // TOP N
  if (normalized.includes('top') && metricColumn) {
    const numMatch = normalized.match(/top\s+(\d+)/);
    const n = numMatch ? parseInt(numMatch[1], 10) : 10;
    return { ...sortedList(`Top ${n} by ${metricColumn}`, currentRows, summary.columns, metricColumn, 'desc', n),
      insight: `Top ${n} records ranked by ${metricColumn} (descending).` };
  }

  // BOTTOM N
  if (normalized.includes('bottom') && metricColumn) {
    const numMatch = normalized.match(/bottom\s+(\d+)/);
    const n = numMatch ? parseInt(numMatch[1], 10) : 10;
    return { ...sortedList(`Bottom ${n} by ${metricColumn}`, currentRows, summary.columns, metricColumn, 'asc', n),
      insight: `Bottom ${n} records ranked by ${metricColumn} (ascending).` };
  }

  // SHOW / LIST
  if (normalized.includes('show') || normalized.includes('list') || normalized.includes('all') || anyColumn) {
    return { type: 'list', title: anyColumn ? `Records with ${anyColumn}` : 'All Records',
      rows: currentRows.slice(0, 50), columns: summary.columns,
      insight: `Showing ${Math.min(currentRows.length, 50)} of ${currentRows.length} records.` };
  }

  return { type: 'metric', title: 'Query Help', value: buildQueryHint(summary), insight: '' };
}

function groupByColumn(rows, groupCol, aggCol) {
  const groups = {};
  rows.forEach(row => {
    const key = String(row[groupCol] || 'Unknown');
    if (!groups[key]) groups[key] = { count: 0, sum: 0, values: [] };
    groups[key].count++;
    if (aggCol && typeof row[aggCol] === 'number') { groups[key].sum += row[aggCol]; groups[key].values.push(row[aggCol]); }
  });
  return Object.entries(groups).map(([key, g]) => {
    const result = { [groupCol]: key, Count: g.count };
    if (aggCol && g.values.length) result[`Avg ${aggCol}`] = Number((g.sum / g.values.length).toFixed(2));
    return result;
  }).sort((a, b) => b.Count - a.Count);
}

function parseWordFilter(query, columns) {
  const patterns = [
    { regex: /(\w[\w\s]*?)\s+below\s+([\d.]+)/, operator: '<', label: 'below' },
    { regex: /(\w[\w\s]*?)\s+above\s+([\d.]+)/, operator: '>', label: 'above' },
    { regex: /(\w[\w\s]*?)\s+less\s+than\s+([\d.]+)/, operator: '<', label: 'less than' },
    { regex: /(\w[\w\s]*?)\s+greater\s+than\s+([\d.]+)/, operator: '>', label: 'greater than' },
    { regex: /(\w[\w\s]*?)\s+at\s+least\s+([\d.]+)/, operator: '>=', label: 'at least' },
    { regex: /(\w[\w\s]*?)\s+at\s+most\s+([\d.]+)/, operator: '<=', label: 'at most' },
    { regex: /(\w[\w\s]*?)\s+equal(?:s|s to)?\s+([\w.]+)/, operator: '=', label: 'equals' }
  ];
  for (const p of patterns) {
    const m = query.match(p.regex);
    if (m) {
      const colHint = m[1].trim();
      const rawValue = m[2].trim();
      const col = columns.find(c => colHint.includes(c.toLowerCase())) || columns.find(c => c.toLowerCase().includes(colHint));
      if (!col) continue;
      const numeric = Number(rawValue.replace(/,/g, ''));
      return { column: col, operator: p.operator, label: p.label, rawValue, value: Number.isFinite(numeric) ? numeric : rawValue.toLowerCase() };
    }
  }
  return null;
}

function parseFilter(query, columns) {
  const column = findColumnInQuery(query, columns);
  const match = query.match(/(<=|>=|<|>|=)\s*([\w .-]+)/);
  if (!column || !match) return null;
  const rawValue = match[2].trim();
  const numeric = Number(rawValue.replace(/,/g, ''));
  return { column, operator: match[1], rawValue, value: Number.isFinite(numeric) ? numeric : rawValue.toLowerCase() };
}

function compareValue(cellValue, operator, targetValue) {
  const left = typeof cellValue === 'number' ? cellValue : String(cellValue || '').toLowerCase();
  const right = targetValue;
  if (operator === '=') return left === right;
  if (typeof left !== 'number' || typeof right !== 'number') return false;
  if (operator === '<') return left < right;
  if (operator === '>') return left > right;
  if (operator === '<=') return left <= right;
  if (operator === '>=') return left >= right;
  return false;
}

function sortedList(title, currentRows, columns, metricColumn, direction, limit = 10) {
  const m = direction === 'desc' ? -1 : 1;
  return {
    type: 'list', title,
    rows: [...currentRows].sort((a, b) => {
      const valA = a[metricColumn];
      const valB = b[metricColumn];
      if (typeof valA === 'string' && typeof valB === 'string') return valA.localeCompare(valB) * m;
      return ((Number(valA) || 0) - (Number(valB) || 0)) * m;
    }).slice(0, limit),
    columns
  };
}

// -- MODULE 3: SUMMARY & CHARTS ------------------------------------------------

function buildSummary(currentRows) {
  const columns = getColumns(currentRows);
  const numericColumns = getNumericColumns(currentRows, columns);
  const textColumns = columns.filter(c => !numericColumns.includes(c));
  const labelColumn = pickLabelColumn(columns, numericColumns);
  const primaryMetric = numericColumns[0] || null;

  return {
    storage: 'PostgreSQL',
    rows: currentRows,
    columns,
    numericColumns,
    textColumns,
    labelColumn,
    primaryMetric,
    stats: buildStats(currentRows, columns, numericColumns),
    schema: columns.map(c => ({ name: c, type: numericColumns.includes(c) ? 'Number' : 'Text' })),
    barChart: buildBarChart(currentRows, labelColumn, primaryMetric),
    pieChart: buildPieChart(currentRows, textColumns, primaryMetric),
    lineChart: buildLineChart(currentRows, labelColumn, primaryMetric),
    hBarChart: buildHBarChart(currentRows, labelColumn, primaryMetric),
    radarChart: buildRadarChart(currentRows, labelColumn, numericColumns),
    insightReport: buildInsightReport(currentRows, columns, numericColumns, textColumns, labelColumn),
    chartRecommendations: GEMINI_API_KEY ? getAIChartRecommendations(currentRows, columns, numericColumns, textColumns, labelColumn, primaryMetric) : null
  };
}

function buildStats(currentRows, columns, numericColumns) {
  const stats = [
    { label: 'Total Records', value: currentRows.length, tone: 'cyan' },
    { label: 'Columns', value: columns.length, tone: 'green' }
  ];
  // Exclude ID/serial columns from stats
  const metricsForStats = numericColumns.filter(c => !isIdColumn(c, currentRows));
  metricsForStats.slice(0, 2).forEach((col, i) => {
    stats.push({ label: `Avg ${col}`, value: formatNumber(averageOf(getNumbers(currentRows, col))), tone: i === 0 ? 'amber' : 'rose' });
  });
  if (stats.length < 3) stats.push({ label: 'Numeric Fields', value: numericColumns.length, tone: 'amber' });
  return stats.slice(0, 4);
}

function buildBarChart(currentRows, labelColumn, metricColumn) {
  const columns = getColumns(currentRows);
  const numericColumns = getNumericColumns(currentRows, columns);
  const textColumns = columns.filter(c => !numericColumns.includes(c));

  // Pick metric: prefer non-ID numeric columns
  const metricCols = numericColumns.filter(c => !isIdColumn(c, currentRows));
  const primaryMetric = (metricCols.includes(metricColumn) ? metricColumn : null) || metricCols[0] || numericColumns[0];

  if (!primaryMetric) {
    return { title: 'Dataset Overview', labels: ['Total Records'], values: [currentRows.length], metric: 'Count' };
  }

  // Pick best category column for grouping (prefer department/section/type, avoid unique-ID-like columns)
  const categoryCol = pickBestCategoryColumn(currentRows, textColumns) || labelColumn;

  if (!categoryCol) {
    // No grouping column — show top values of the primary metric across all rows
    const sorted = [...currentRows]
      .filter(r => typeof r[primaryMetric] === 'number')
      .sort((a, b) => b[primaryMetric] - a[primaryMetric])
      .slice(0, 15);
    const nameCol = textColumns.find(c => /name|title|label/i.test(c)) || textColumns[0];
    return {
      title: `Top Records by ${primaryMetric}`,
      labels: sorted.map((r, i) => nameCol ? String(r[nameCol] || `Row ${i+1}`).substring(0, 20) : `Row ${i+1}`),
      values: sorted.map(r => Number(r[primaryMetric]) || 0),
      metric: primaryMetric,
      aggregation: 'top'
    };
  }

  // Group by category and calculate average of primary metric
  const groups = {};
  currentRows.forEach(row => {
    const key = String(row[categoryCol] || 'Other');
    if (!groups[key]) groups[key] = { sum: 0, count: 0 };
    const val = Number(row[primaryMetric]);
    if (typeof row[primaryMetric] === 'number' || !isNaN(val)) {
      groups[key].sum += val;
      groups[key].count++;
    }
  });

  const labels = Object.keys(groups).sort();
  const values = labels.map(label =>
    groups[label].count > 0 ? Number((groups[label].sum / groups[label].count).toFixed(2)) : 0
  );

  return {
    title: `Average ${primaryMetric} by ${categoryCol}`,
    labels,
    values,
    metric: primaryMetric,
    category: categoryCol,
    aggregation: 'average',
    sampleSize: labels.length
  };
}

function buildPieChart(currentRows, textColumns, metricColumn) {
  // Priority 1: Best category column (prefer Department/Status/Gender with 2–8 unique values)
  const priorityPatterns = [
    /department|dept|division|branch|section|class/i,
    /status|result|grade|level|placement|eligible/i,
    /gender|sex/i,
    /type|category|group/i,
    /city|country|region|location/i
  ];
  
  let bestCatCol = null;
  for (const pattern of priorityPatterns) {
    const match = textColumns.find(c => {
      const unique = uniqueValues(currentRows, c).length;
      return pattern.test(c) && unique >= 2 && unique <= 10;
    });
    if (match) { bestCatCol = match; break; }
  }

  // Fallback: any text column with 2–10 unique values (excluding pure-name/ID columns)
  if (!bestCatCol) {
    bestCatCol = textColumns
      .filter(c => !/^name$|email|phone|mobile|^id$|serial|roll/i.test(c))
      .find(c => {
        const unique = uniqueValues(currentRows, c).length;
        return unique >= 2 && unique <= 10;
      });
  }

  if (bestCatCol) {
    const counts = countBy(currentRows, bestCatCol);
    const total = currentRows.length;
    // Sort by count descending for better visual
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return {
      title: `Distribution by ${bestCatCol}`,
      labels: sorted.map(([k]) => k),
      values: sorted.map(([, v]) => v),
      percentages: sorted.map(([, v]) => `${((v/total)*100).toFixed(1)}%`)
    };
  }

  // Priority 2: Band a numeric metric into Low/Medium/High
  const numericCols = getNumericColumns(currentRows, getColumns(currentRows));
  const metricCols = numericCols.filter(c => !isIdColumn(c, currentRows));
  const metric = (metricCols.includes(metricColumn) ? metricColumn : null) || metricCols[0];
  if (metric) {
    const values = getNumbers(currentRows, metric);
    if (values.length > 0) {
      const sorted = [...values].sort((a, b) => a - b);
      const p33 = sorted[Math.floor(sorted.length * 0.33)];
      const p66 = sorted[Math.floor(sorted.length * 0.66)];
      return {
        title: `${metric} Level Distribution`,
        labels: ['Low', 'Medium', 'High'],
        values: [
          values.filter(v => v <= p33).length,
          values.filter(v => v > p33 && v <= p66).length,
          values.filter(v => v > p66).length
        ]
      };
    }
  }

  return { title: 'Dataset Overview', labels: ['Total Records'], values: [currentRows.length] };
}

function buildLineChart(currentRows, labelColumn, metricColumn) {
  const columns = getColumns(currentRows);
  const numericColumns = getNumericColumns(currentRows, columns);
  const textColumns = columns.filter(c => !numericColumns.includes(c));

  const metricCols = numericColumns.filter(c => !isIdColumn(c, currentRows));
  if (!metricCols.length) return null;
  const primaryMetric = (metricCols.includes(metricColumn) ? metricColumn : null) || metricCols[0];
  const PLACEHOLDER_START = '  // Strategy 1: If we have a date/time column';
  
  // Strategy 1: If we have a date/time column, show time series
  const dateCol = textColumns.find(c => /date|time|year|month|day/i.test(c));
  if (dateCol) {
    const sorted = [...currentRows].sort((a, b) => String(a[dateCol]).localeCompare(String(b[dateCol])));
    const limited = sorted.slice(0, 40);
    
    return {
      title: `${primaryMetric} Over Time (by ${dateCol})`,
      labels: limited.map(row => {
        const label = String(row[dateCol]);
        return label.length > 12 ? label.substring(0, 12) + '...' : label;
      }),
      values: limited.map(row => Number(row[primaryMetric]) || 0),
      metric: primaryMetric,
      timeSeries: true
    };
  }
  
  // Strategy 2: If we have categories, show trend across categories
  const categoryCol = textColumns.find(c => {
    const unique = new Set(currentRows.map(r => r[c])).size;
    return unique >= 3 && unique <= 20 && !/name|email|phone|id/i.test(c);
  });
  
  if (categoryCol) {
    const groups = {};
    currentRows.forEach(row => {
      const key = String(row[categoryCol]);
      if (!groups[key]) groups[key] = [];
      const val = Number(row[primaryMetric]);
      if (!isNaN(val)) groups[key].push(val);
    });
    
    const labels = Object.keys(groups);
    const values = labels.map(label => {
      const vals = groups[label];
      return Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2));
    });
    
    return {
      title: `${primaryMetric} Trend by ${categoryCol}`,
      labels: labels,
      values: values,
      metric: primaryMetric,
      categoryTrend: true
    };
  }
  
  // Strategy 3: Show distribution trend (binned data)
  const values = getNumbers(currentRows, primaryMetric);
  if (values.length >= 10) {
    const bins = 10;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const binSize = (max - min) / bins;
    const binCounts = new Array(bins).fill(0);
    
    values.forEach(v => {
      const bin = Math.min(Math.floor((v - min) / binSize), bins - 1);
      binCounts[bin]++;
    });
    
    return {
      title: `${primaryMetric} Distribution Trend`,
      labels: Array.from({length: bins}, (_, i) => {
        const rangeStart = (min + i * binSize).toFixed(1);
        return `${rangeStart}`;
      }),
      values: binCounts,
      metric: primaryMetric,
      distribution: true
    };
  }
  
  // Fallback: Simple record-by-record trend
  return {
    title: `${primaryMetric} Trend (All Records)`,
    labels: currentRows.map((_, i) => `#${i + 1}`).slice(0, 30),
    values: currentRows.map(row => Number(row[primaryMetric]) || 0).slice(0, 30),
    metric: primaryMetric
  };
}

function buildHBarChart(currentRows, labelColumn, metricColumn) {
  const columns = getColumns(currentRows);
  const numericColumns = getNumericColumns(currentRows, columns);
  const textColumns = columns.filter(c => !numericColumns.includes(c));

  // Pick best metric (non-ID numeric column)
  const metricCols = numericColumns.filter(c => !isIdColumn(c, currentRows));
  if (!metricCols.length) return null;
  const metric = (metricCols.includes(metricColumn) ? metricColumn : null) || metricCols[0];

  // Pick best label column: prefer name/title, then any non-numeric col with many unique values
  const namePriority = [/name|title|label|student|employee/i, /^(?!.*id|.*roll|.*serial).*$/i];
  let nameCol = null;
  for (const pattern of namePriority) {
    nameCol = textColumns.find(c => pattern.test(c));
    if (nameCol) break;
  }
  if (!nameCol) nameCol = labelColumn || textColumns[0];

  // Sort records by metric descending, take top 10
  const sorted = [...currentRows]
    .filter(r => typeof r[metric] === 'number' || !isNaN(Number(r[metric])))
    .sort((a, b) => (Number(b[metric]) || 0) - (Number(a[metric]) || 0))
    .slice(0, 10);

  return {
    title: `Top 10 ${nameCol || 'Records'} by ${metric}`,
    labels: sorted.map((row, i) => {
      const label = nameCol ? String(row[nameCol] || `Row ${i+1}`) : `Row ${i+1}`;
      return label.length > 20 ? label.substring(0, 20) + '...' : label;
    }),
    values: sorted.map(row => Number(row[metric]) || 0),
    metric
  };
}

function buildRadarChart(currentRows, labelColumn, numericColumns) {
  if (numericColumns.length < 2) return null;
  const sampleRows = currentRows.slice(0, 6);
  return {
    title: 'Multi-Metric Comparison',
    labels: numericColumns.slice(0, 6),
    datasets: sampleRows.map(row => ({
      label: String(row[labelColumn] || 'Row'),
      values: numericColumns.slice(0, 6).map(col => Number(row[col]) || 0)
    }))
  };
}

function buildInsightReport(currentRows, columns, numericColumns, textColumns, labelColumn) {
  const insights = [];
  insights.push(`Dataset has ${currentRows.length} record${currentRows.length !== 1 ? 's' : ''} and ${columns.length} columns.`);

  numericColumns.slice(0, 3).forEach(col => {
    const vals = getNumbers(currentRows, col);
    if (!vals.length) return;
    const maxVal = Math.max(...vals), minVal = Math.min(...vals), avg = averageOf(vals);
    const maxRow = currentRows.find(r => r[col] === maxVal);
    const minRow = currentRows.find(r => r[col] === minVal);
    const maxLabel = maxRow ? (maxRow[labelColumn] || '') : '';
    const minLabel = minRow ? (minRow[labelColumn] || '') : '';
    insights.push(`${col} — Highest: ${formatNumber(maxVal)}${maxLabel ? ` (${maxLabel})` : ''}, Lowest: ${formatNumber(minVal)}${minLabel ? ` (${minLabel})` : ''}, Mean: ${formatNumber(avg)}.`);
  });

  textColumns.slice(0, 2).forEach(col => {
    const counts = countBy(currentRows, col);
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top) insights.push(`Most common ${col}: "${top[0]}" (${top[1]} records, ${Math.round(top[1] / currentRows.length * 100)}%).`);
  });

  return insights;
}

// -- UTILITY -------------------------------------------------------------------

function getColumns(rows) { return [...new Set(rows.flatMap(r => Object.keys(r)))]; }

function getNumericColumns(rows, columns) {
  return columns.filter(col => {
    const vals = rows.map(r => r[col]).filter(v => v !== '' && v !== null && v !== undefined);
    if (!vals.length) return false;
    // A column is numeric if >= 75% of non-empty values are finite numbers
    const numericCount = vals.filter(v => typeof v === 'number' && Number.isFinite(v)).length;
    return numericCount / vals.length >= 0.75;
  });
}

// Detect if a column is an auto-increment ID / serial number (not a useful metric)
function isIdColumn(col, rows) {
  if (/^(id|serial|seq|no\.?|s\.?no\.?|sl\.?no\.?|roll\s*no|sno|row\s*id)$/i.test(col.trim())) return true;
  // Numeric but values are sequential integers starting at 1 or low numbers
  const vals = rows.map(r => r[col]).filter(v => typeof v === 'number');
  if (!vals.length) return false;
  const sorted = [...vals].sort((a, b) => a - b);
  const isSeq = sorted.every((v, i) => i === 0 || v === sorted[i-1] + 1);
  const isAllInt = vals.every(v => Number.isInteger(v));
  if (isSeq && isAllInt && sorted[0] >= 1 && sorted[0] <= 10) return true;
  return false;
}

// Pick the best category column for chart grouping
function pickBestCategoryColumn(rows, textColumns) {
  const priorityPatterns = [
    /department|dept|division|branch|section|stream|class/i,
    /placement|eligible|result|pass|fail/i,
    /status|state|stage|level/i,
    /gender|sex/i,
    /grade|tier|rank/i,
    /type|category|group/i,
    /city|country|region|location/i
  ];
  const avoidPattern = /^name$|email|phone|mobile|^id$|serial|roll|address|description|remark|comment/i;
  
  // First pass: priority patterns
  for (const pattern of priorityPatterns) {
    const match = textColumns.find(c => {
      if (avoidPattern.test(c)) return false;
      const unique = new Set(rows.map(r => String(r[c] || ''))).size;
      return pattern.test(c) && unique >= 2 && unique <= 20;
    });
    if (match) return match;
  }
  
  // Second pass: any non-ID text column with reasonable cardinality (2-15 unique values)
  return textColumns.find(c => {
    if (avoidPattern.test(c)) return false;
    const unique = new Set(rows.map(r => String(r[c] || ''))).size;
    return unique >= 2 && unique <= 15;
  }) || null;
}

function pickLabelColumn(columns, numericColumns) {
  const textCols = columns.filter(c => !numericColumns.includes(c));
  
  // Priority order: Department/Category first, then other grouping columns, avoid Name/ID
  const priorityPatterns = [
    /department|dept|division|category|type|class|section|branch/i,  // Grouping columns
    /status|state|stage|level|grade/i,                                // Status columns
    /city|country|region|location|place/i,                             // Location columns
  ];
  
  for (const pattern of priorityPatterns) {
    const match = textCols.find(c => pattern.test(c));
    if (match) return match;
  }
  
  // Avoid using Name, ID, Email, Phone as label (too unique)
  const avoidPatterns = /name|email|phone|mobile|id|number|roll/i;
  const goodCols = textCols.filter(c => !avoidPatterns.test(c));
  
  // Return first non-unique column, or fallback to first text column
  return goodCols[0] || textCols[0] || columns[0] || 'Row';
}

function findColumnInQuery(query, columns) {
  // Direct match first
  const directMatch = columns.find(c => query.includes(c.toLowerCase()));
  if (directMatch) return directMatch;
  
  // Synonym/abbreviation mapping
  const synonymMap = {
    'dept': 'Department',
    'department': 'Department',
    'div': 'Department',
    'name': 'Name',
    'student': 'Name',
    'employee': 'Name',
    'cgpa': 'CGPA',
    'gpa': 'CGPA',
    'grade': 'CGPA',
    'score': 'CGPA',
    'attendance': 'Attendance',
    'present': 'Attendance',
    'placement': 'Placement',
    'job': 'Placement'
  };
  
  // Check if any synonym keyword is in the query
  for (const [keyword, column] of Object.entries(synonymMap)) {
    if (query.includes(keyword) && columns.includes(column)) {
      return column;
    }
  }
  
  return null;
}
function getNumbers(rows, col) { return rows.map(r => r[col]).filter(v => typeof v === 'number' && Number.isFinite(v)); }
function uniqueValues(rows, col) { return [...new Set(rows.map(r => String(r[col] || 'Blank')))]; }
function countBy(rows, col) { return rows.reduce((acc, r) => { const k = String(r[col] || 'Blank'); acc[k] = (acc[k] || 0) + 1; return acc; }, {}); }
function averageOf(vals) { return vals.length ? sumOf(vals) / vals.length : 0; }
function sumOf(vals) { return vals.reduce((t, v) => t + v, 0); }
function formatNumber(v) { return Number.isFinite(v) ? Number(v.toFixed(2)).toLocaleString() : '0'; }
function buildQueryHint(summary) { const m = summary.primaryMetric || 'a column'; return `Try: average ${m} · top 10 · ${m} below 75 · count by department · sort by ${m}`; }

// -- STATIC FILES & RESPONSE ---------------------------------------------------

function serveStatic(req, res) {
  const reqPath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');
  fs.readFile(filePath, (err, content) => {
    if (err) return sendText(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    const ct = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(content);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, msg) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}
