// netlify/functions/save-data.js
// Called by the app whenever data changes
// Stores entries, events, waConfig to Netlify Blob

import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const body = await req.json();
    const { entries, events, waConfig, settings } = body;

    const store = getStore({ name: 'pajaksim', consistency: 'strong' });

    // Save all data
    if (entries !== undefined) await store.set('entries', JSON.stringify(entries));
    if (events  !== undefined) await store.set('events',  JSON.stringify(events));
    if (waConfig !== undefined) {
      // Strip sensitive token for logging but save full config
      await store.set('waConfig', JSON.stringify(waConfig));
    }
    if (settings !== undefined) await store.set('settings', JSON.stringify(settings));

    return new Response(JSON.stringify({ ok: true, saved: new Date().toISOString() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    console.error('save-data error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
};

export const config = {
  path: "/api/save-data"
};
