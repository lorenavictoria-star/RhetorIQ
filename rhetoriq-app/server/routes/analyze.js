const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Module prompts
const PROMPTS = {
  rp: {
    label: 'Executive Rhetoric Profiling',
    system: `You are an expert in rhetoric and executive communication, grounded in Aristotle, Perelman, and Cicero. Analyse the rhetorical architecture of leadership texts with academic precision. Structure: 1. ARGUMENTATION LOGIC, 2. PERSUASION STRATEGY (Ethos/Pathos/Logos with direct textual evidence), 3. LINGUISTIC SIGNATURES (characteristic patterns), 4. STRATEGIC STRENGTHS, 5. BLIND SPOTS & RISKS. Direct, actionable. In English.`,
    build: (d) => `Executive Rhetoric Profile for ${d.name||'the executive'}${d.industry?' ('+d.industry+')':''}:\n\n${d.text}`
  },
  cf: {
    label: 'Communication Fingerprint',
    system: `You are an expert in longitudinal linguistic analysis of leadership communication. Analyse how a person's language shifts across time or contexts. Identify: tone drift, behaviour under pressure, rhetorical patterns that strengthen or weaken, trust signals, consistency vs. inconsistency. Structure: 1. OVERALL DEVELOPMENT, 2. CRITICAL SHIFTS (with direct textual evidence), 3. PATTERNS UNDER PRESSURE, 4. STRATEGIC IMPLICATIONS. Academic rigour, actionable output. In English.`,
    build: (d) => `Communication Fingerprint for ${d.name||'the executive'}. Focus: ${d.focus}.\n\n${d.text}`
  },
  la: {
    label: 'Language Analytics',
    system: `You are an expert in organisational communication analysis (linguistics, rhetoric, organisational psychology). Analyse internal company texts. Identify: gaps between stated and lived culture, power dynamics in language, trust climate, cultural tensions. Structure: 1. CULTURE FINDING, 2. CRITICAL LANGUAGE SYMPTOMS (with textual evidence), 3. LEADERSHIP–EMPLOYEE GAP, 4. RECOMMENDATIONS. In English.`,
    build: (d) => `Language Analytics (${d.size}, focus: ${d.focus}):\n\n${d.text}`
  },
  rm: {
    label: 'Risk Management',
    system: `You are an expert in preventive communication risk analysis (reception psychology, rhetoric). Analyse communication BEFORE it goes out. Structure: 1. OVERALL RISK LEVEL (low/medium/high/critical + rationale), 2. CRITICAL FORMULATIONS (quote + precise risk explanation), 3. LIKELY MISRECEPTIONS, 4. RESISTANCE POTENTIAL by audience, 5. CONCRETE REVISION RECOMMENDATIONS. Direct, precise. In English.`,
    build: (d) => `Audience: ${d.audience}\nContext: ${d.context}\n\nText:\n${d.text}`
  },
  st: {
    label: 'Argument Stress Test',
    system: `You are an expert in strategic communication and argumentation analysis. Generate the strongest possible counterarguments to a thesis from multiple perspectives — not balanced, but maximally challenging. For each perspective: 1. STRONGEST COUNTERARGUMENT, 2. EMOTIONAL ATTACK POINT, 3. RHETORICAL TRAP. Then: RECOMMENDED RESPONSE STRATEGIES for each counterargument. In English, precise.`,
    build: (d) => `Thesis: ${d.text}\nPerspectives: ${d.perspectives}\nIntensity: ${d.intensity}`
  },
  si: {
    label: 'Strategic Impact Simulation',
    system: `You are an expert in strategic communication and stakeholder management (reception psychology). Simulate realistic stakeholder reactions. For each group: immediate emotional reaction, cognitive interpretation, likely action, critical misunderstandings. Conclusion: overall risk assessment + top 3 strategic adjustments. In English.`,
    build: (d) => `Stakeholders: ${d.stakeholders}\nContext: ${d.severity}\n\nCommunication:\n${d.text}`
  },
  as: {
    label: 'Actionability Scanner',
    system: `You are an expert in pragmatic linguistics and leadership communication. Analyse instructions for operationalisability. Identify: vague verbs ("take a look", "handle"), missing deadlines, unclear responsibilities, unmeasurable goals, interpretation gaps. Then: precise rewrite. Structure: 1. VAGUENESS FINDINGS (quote + explanation), 2. MISSING ELEMENTS, 3. REVISED VERSION. Direct, in English.`,
    build: (d) => `Context: ${d.context}\nRecipient: ${d.recipient}\n\nInstruction:\n${d.text}`
  },
  tc: {
    label: 'Thread Cleaner',
    system: `You are an expert in argumentation analysis and executive communication. Analyse communication threads and extract the logical decision structure. Do not summarise — extract the argumentative architecture. Structure: 1. CORE QUESTION (one precise question), 2. OPTIONS (max. 3, with pros/cons), 3. COUNTERARGUMENTS (who argues what), 4. OPEN POINTS / BLOCKERS, 5. RECOMMENDED DECISION BASIS. Maximum half a page. In English.`,
    build: (d) => `Source: ${d.source}\nGoal: ${d.goal}\n\nThread:\n${d.text}`
  },
  'vs-cal': {
    label: 'Voice Signature — Calibration',
    system: `You are a ghostwriting expert for executive communication. Create a precise Voice Signature Profile as the foundation for scalable ghostwriting. Structure: 1. CORE TONALITY & REGISTER, 2. CHARACTERISTIC SENTENCE STRUCTURES (with examples from the texts), 3. VOCABULARY SIGNATURE (preferred words, avoided formulations), 4. ARGUMENTATION SEQUENCE, 5. EMOTIONAL INTENSITY, 6. GHOSTWRITING DIRECTIVES for future texts. Actionable, precise. In English.`,
    build: (d) => `Voice Signature Profile from:\n\n${d.text}`
  },
  'vs-gen': {
    label: 'Voice Signature — Generation',
    system: (d) => `You are a precision ghostwriter for executives. Write exclusively in the style of the Voice Signature Profile. The person must immediately recognise themselves. No generic tone.${d.voiceProfile?'\n\nVoice Signature:\n'+d.voiceProfile:''}`,
    build: (d) => `Format: ${d.format}\nTone: ${d.tone}\nBriefing: ${d.text}`
  },
  pr: {
    label: 'Performance Review',
    system: `You are an expert in HR communication and psycholinguistics calibrated to Swiss and European corporate culture. Formulate feedback that is rhetorically precise, development-oriented, and clear — without softening the substance or creating unnecessary attack surfaces. Structure: 1. STRENGTHS (specific, performance-based), 2. DEVELOPMENT AREAS (direct but constructive), 3. RECOMMENDATION / NEXT STEPS. Swiss directness, no US motivational clichés. In English.`,
    build: (d) => `Format: ${d.format}\nRole: ${d.role||'employee'}\n\nRaw feedback:\n${d.text}`
  },
  rw: {
    label: 'Recognition Writer',
    system: `You are an expert in leadership communication and recognition culture calibrated to Swiss and European corporate norms. Formulate recognition that: refers to the concrete achievement, is psychologically calibrated to the recipient type, respects European directness (no American motivational kitsch), links the action to the impact on the team or organisation. No "thanks for your great effort". Precise, authentic, effective. In English.`,
    build: (d) => `Recipient type: ${d.type}\nFormat: ${d.format}\n\nConcrete achievement:\n${d.text}`
  }
};

async function callClaude(system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: typeof system === 'function' ? system({}) : system,
      messages: [{ role: 'user', content: user }]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || '';
}

// POST /api/analyze
router.post('/', requireAuth, async (req, res) => {
  try {
    const { module, clientId, data } = req.body;
    const cfg = PROMPTS[module];
    if (!cfg) return res.status(400).json({ error: 'Unknown module' });

    const system = typeof cfg.system === 'function' ? cfg.system(data) : cfg.system;
    const userMsg = cfg.build(data);

    const result = await callClaude(system, userMsg);

    // Persist analysis
    const advisorId = req.user.role === 'advisor' ? req.user.id : req.user.advisorId;
    const resolvedClientId = clientId || (req.user.role === 'client' ? req.user.clientId : null);

    const { rows } = await pool.query(
      `INSERT INTO analyses (client_id, advisor_id, module, module_label, input_data, result)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [resolvedClientId, advisorId, module, cfg.label, data, result]
    );

    const analysis = { id: rows[0].id, module, label: cfg.label, result, createdAt: rows[0].created_at, clientId: resolvedClientId };

    // Push via WebSocket to connected clients/advisor
    if (req.app.locals.wss) {
      req.app.locals.wss.broadcast({ type: 'analysis', analysis });
    }

    res.json({ result, id: rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// GET /api/analyze/history
router.get('/history', requireAuth, async (req, res) => {
  try {
    const clientId = req.user.role === 'client' ? req.user.clientId : (req.query.clientId || null);
    const advisorId = req.user.role === 'advisor' ? req.user.id : req.user.advisorId;

    let query, params;
    if (clientId) {
      query = `SELECT id, module, module_label, result, created_at FROM analyses WHERE client_id = $1 AND advisor_id = $2 ORDER BY created_at DESC LIMIT 50`;
      params = [clientId, advisorId];
    } else {
      query = `SELECT id, module, module_label, result, created_at, client_id FROM analyses WHERE advisor_id = $1 ORDER BY created_at DESC LIMIT 50`;
      params = [advisorId];
    }

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
