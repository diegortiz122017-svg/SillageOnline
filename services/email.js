'use strict';

const cfg = require('../config');

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function send({ to, from, subject, html, text }) {
  if (!cfg.RESEND_API_KEY) {
    console.warn('⚠️  RESEND_API_KEY not set — email skipped:', subject);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${cfg.RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    from || `Sillage Parfumerie <${cfg.EMAIL_HOLA}>`,
      to:      Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) console.error('Email error:', data);
  else console.log('✅ Email sent to', to, '— id:', data.id);
  return data;
}

// ─── Generate Nez note via OpenAI ────────────────────────────────────────────
async function buildNezNote(order) {
  if (!cfg.OPENAI_API_KEY) return null;
  try {
    const items = (order.items || []).map(i => i.name || i.productName || '').filter(Boolean).join(', ');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${cfg.OPENAI_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model:      'gpt-4o-mini',
        max_tokens: 200,
        messages: [{
          role:    'user',
          content: `Eres Nez, el sommelier de Sillage Parfumerie. Escribe una nota de 2-3 oraciones para el email de confirmación de compra de ${escHtml(order.customer)}, quien compró: ${items}. Tono cálido y elegante. Sin saludo, sin despedida elaborada. Termina con "— Nez". Ejemplo: "Black Orchid es una declaración de presencia — oscura, duradera y completamente única. Va a dejar huella. — Nez"`,
        }],
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

// ─── Order confirmation ───────────────────────────────────────────────────────
async function sendOrderConfirmation(order) {
  const nezNote = await buildNezNote(order);
  const BASE    = cfg.BASE_URL;

  const itemsHtml = (order.items || []).map(item =>
    `<tr>
      <td style="padding:8px 0;font-size:13px;color:#1a1714">${escHtml(item.name || item.productName || '')}${item.size ? ` <span style="color:#8a7f72">(${escHtml(item.size)})</span>` : ''}</td>
      <td style="padding:8px 0;font-size:13px;color:#1a1714;text-align:right">$${parseFloat(item.price || 0).toFixed(2)}</td>
    </tr>`
  ).join('');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:'Georgia',serif">
  <div style="max-width:560px;margin:40px auto;background:#ffffff;border:1px solid #e8e0d0">
    <div style="background:#0e0c0a;padding:32px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:24px;letter-spacing:6px;color:#b8955a;text-transform:uppercase">Sillage</div>
      <div style="font-size:9px;letter-spacing:4px;color:#8a7f72;text-transform:uppercase;margin-top:4px">Parfumerie</div>
    </div>
    <div style="padding:40px 36px">
      <p style="font-size:13px;color:#8a7f72;margin:0 0 24px">Hola <strong style="color:#1a1714">${escHtml(order.customer)}</strong>, gracias por tu compra en Sillage Parfumerie.</p>
      <div style="border:1px solid #e8e0d0;padding:20px 24px;margin-bottom:28px">
        <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#b8955a;margin-bottom:12px">Pedido ${escHtml(order.id)}</div>
        <table style="width:100%;border-collapse:collapse">${itemsHtml}</table>
        <div style="border-top:1px solid #e8e0d0;margin-top:12px;padding-top:12px;text-align:right">
          <span style="font-family:Georgia,serif;font-size:18px;color:#b8955a">$${parseFloat(order.total || 0).toFixed(2)}</span>
        </div>
      </div>
      ${nezNote ? `<div style="border-left:2px solid #b8955a;padding:12px 20px;margin-bottom:28px;font-style:italic;font-size:13px;color:#4a3f2f;line-height:1.7">${escHtml(nezNote)}</div>` : ''}
      <p style="font-size:12px;color:#8a7f72;line-height:1.8">Tu pedido está siendo preparado. Te notificaremos cuando esté en camino.</p>
    </div>
    <div style="background:#f5f0e8;padding:20px;text-align:center">
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8a7f72">© ${new Date().getFullYear()} Sillage Parfumerie</div>
    </div>
  </div>
</body>
</html>`;

  return send({
    to:      order.email,
    subject: `✨ Pedido Confirmado — ${escHtml(order.id)} | Sillage Parfumerie`,
    html,
  });
}

// ─── Welcome email ────────────────────────────────────────────────────────────
async function sendWelcomeEmail(customer) {
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:'Georgia',serif">
  <div style="max-width:560px;margin:40px auto;background:#ffffff;border:1px solid #e8e0d0">
    <div style="background:#0e0c0a;padding:32px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:24px;letter-spacing:6px;color:#b8955a;text-transform:uppercase">Sillage</div>
    </div>
    <div style="padding:40px 36px">
      <p style="font-size:13px;color:#1a1714">Bienvenido, <strong>${escHtml(customer.name)}</strong>.</p>
      <p style="font-size:13px;color:#8a7f72;line-height:1.8">Tu cuenta en Sillage Parfumerie está lista. Nez, tu sommelier personal, está disponible para ayudarte a encontrar tu próxima fragancia.</p>
    </div>
    <div style="background:#f5f0e8;padding:20px;text-align:center">
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8a7f72">© ${new Date().getFullYear()} Sillage Parfumerie</div>
    </div>
  </div>
</body>
</html>`;

  return send({
    to:      customer.email,
    subject: 'Bienvenido a Sillage Parfumerie',
    html,
  });
}

// ─── Shipping notification ────────────────────────────────────────────────────
async function sendShippingNotification(order) {
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:'Georgia',serif">
  <div style="max-width:560px;margin:40px auto;background:#ffffff;border:1px solid #e8e0d0">
    <div style="background:#0e0c0a;padding:32px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:24px;letter-spacing:6px;color:#b8955a;text-transform:uppercase">Sillage</div>
    </div>
    <div style="padding:40px 36px">
      <p style="font-size:13px;color:#1a1714">Hola <strong>${escHtml(order.customer)}</strong>,</p>
      <p style="font-size:13px;color:#8a7f72;line-height:1.8">Tu pedido <strong>${escHtml(order.id)}</strong> está en camino.</p>
      <p style="font-size:12px;color:#8a7f72">Si tienes alguna pregunta, responde a este correo.</p>
    </div>
    <div style="background:#f5f0e8;padding:20px;text-align:center">
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8a7f72">© ${new Date().getFullYear()} Sillage Parfumerie</div>
    </div>
  </div>
</body>
</html>`;

  return send({
    to:      order.email,
    subject: `🚚 Tu pedido ${escHtml(order.id)} está en camino — Sillage Parfumerie`,
    html,
  });
}

module.exports = { send, sendOrderConfirmation, sendWelcomeEmail, sendShippingNotification };
