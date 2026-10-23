import{h as I,k,f as p,U as R,Y,j as s}from"./index-D3AEG41Q.js";import{W as _}from"./commission-hXOYgi15.js";import{M as K}from"./MpesaStkButton-CONW4bU0.js";const M=.16;function W(e){const t=e/(1+M);return{net:t,vat:e-t}}const L=80,q="CUSTOMER COPY",G="PRODUCTION COPY";function h(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function Q(e){return e.lineItems.map(t=>{const n=h([t.serviceName,t.materialName].filter(Boolean).join(" + ").toUpperCase()),l=t.itemType==="per-metre"?"m":"",r=t.heatPressFee?`<div class="disc">+ ${p(t.heatPressFee)} heat press fee/pc</div>`:"",u=t.discountPct||t.discountAmt?`<div class="disc">disc ${t.discountPct}% / ${p(t.discountAmt)}</div>`:"";return`
        <div class="item">
          <div class="item-row"><span>${n}</span><span>${p(t.lineTotal)}</span></div>
          <div class="item-sub">${t.qty}${l} &times; ${p(t.unitPrice)}</div>
          ${r}
          ${u}
        </div>`}).join("")}function J(e,t,n,l){var x;if(!e)return;const r=h((n.companyName||"").toUpperCase()),u=n.legalName&&n.legalName.trim()&&n.legalName.trim()!==(n.companyName||"").trim()?`<div class="tagline">Trading name of ${h(n.legalName.trim())}</div>`:"",m=[n.companyAddress,n.companyPhone,n.companyPhone2].filter(o=>!!o&&!!o.trim()).map(h).join(" &middot; "),d=(x=n.website)!=null&&x.trim()?h(n.website.trim()):"",v=t.lineItems.reduce((o,$)=>o+$.qty,0),{net:A,vat:a}=W(t.totals.grandTotal),g=[q,G],i=(o,$)=>`<div class="${$>0?"cut":""}">
  <div class="center">
    ${n.logoDataUrl?`<img class="logo" src="${n.logoDataUrl}" alt="" />`:""}
    <div class="brand">${r}</div>
    ${u}
  </div>
  ${m?`<div class="center meta">${m}</div>`:""}
  ${d?`<div class="center meta">${d}</div>`:""}
  <div class="center meta">${t.totals.balanceDue<=0?"RECEIPT — PAID IN FULL":"INVOICE — BALANCE DUE"}</div>
  <div class="center copy-label">${h(o)}</div>
  <hr />
  <div class="row"><span>ORDER NO.</span><span>${h(t.orderNo)}</span></div>
  <div class="row"><span>DATE</span><span>${I(t.createdDate,t.capturedAt)}</span></div>
  ${t.totals.balanceDue>0&&t.dueDate?`<div class="row"><span>PAY BY</span><span>${k(t.dueDate)}</span></div>`:""}
  <div class="row"><span>CUSTOMER</span><span>${h(t.customerName||"—")}</span></div>
  ${t.phone?`<div class="row"><span>PHONE</span><span>${h(t.phone)}</span></div>`:""}
  <div class="row"><span>SERVED BY</span><span>${h(t.staff.name)}</span></div>
  ${t.capturedByName?`<div class="row"><span>CASHIER</span><span>${h(t.capturedByName)}</span></div>`:""}
  <hr />
  ${Q(t)}
  <hr />
  <div class="totals">
    <div class="row"><span>SUBTOTAL</span><span>${p(t.totals.subtotal)}</span></div>
    ${t.totals.orderDiscount>0?`<div class="row"><span>DISCOUNT</span><span>-${p(t.totals.orderDiscount)}</span></div>`:""}
    <div class="row grand"><span>TOTAL</span><span>${p(t.totals.grandTotal)}</span></div>
    <div class="row vat-note"><span>Incl. VAT (16%)</span><span>${p(a)}</span></div>
    <div class="row vat-note"><span>Net amount</span><span>${p(A)}</span></div>
  </div>
  <hr />
  ${t.payments.map(D=>`<div class="row"><span>${k(D.date)} ${h(D.method).toUpperCase()}</span><span>${R(D.amount)}</span></div>`).join("")}
  ${t.totals.balanceDue>0?`<div class="row balance"><span>BALANCE DUE</span><span>${R(t.totals.balanceDue)}</span></div>`:""}
  <hr />
  <div class="keep-note">${t.totals.balanceDue>0?"PAY THE BALANCE AGAINST THIS ORDER NUMBER":"PLEASE KEEP THIS RECEIPT FOR YOUR RECORDS"}</div>
  <div class="keep-note">ITEMS: ${v}</div>
  <div class="barcode-wrap"><svg id="barcode${$}"></svg></div>
  <div class="footer">Thank you for choosing ${r}!</div>
  ${d?`<div class="footer">${d}</div>`:""}
  <div class="footer">${I(t.createdDate,t.capturedAt)}</div>
</div>`,E=`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${t.orderNo}</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
<style>
  @page { size: ${L}mm auto; margin: 2mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  /* A thermal head burns solid black dots, so thin strokes and grey text break up and fade. Everything is a heavy sans-serif in pure black, with a
     hairline stroke added to thicken the letters — Courier New's fine strokes were what printed faintly. */
  body {
    width: ${L-6}mm; margin: 0 auto; padding: 2mm 1mm;
    font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; font-size: 12.5px; font-weight: 700; line-height: 1.25; color: #000;
    -webkit-text-stroke: 0.25px #000;
  }
  .center { text-align: center; }
  .logo { display: block; margin: 0 auto 3px; max-width: 46mm; max-height: 20mm; object-fit: contain; filter: grayscale(1) contrast(1.3); }
  .brand { font-size: 20px; font-weight: 900; letter-spacing: 0.02em; }
  .tagline { font-size: 11.5px; color: #000; margin-top: 1px; }
  .meta { font-size: 11.5px; color: #000; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  hr { border: none; border-top: 2px dashed #000; margin: 5px 0; }
  .item-row { display: flex; justify-content: space-between; gap: 6px; font-weight: 900; overflow-wrap: anywhere; }
  .item-sub, .disc { font-size: 11.5px; color: #000; padding-left: 4px; }
  .totals .row { padding: 1px 0; }
  .grand { font-weight: 900; font-size: 16px; border-top: 2px solid #000; margin-top: 3px; padding-top: 3px; }
  .vat-note { font-size: 11.5px; color: #000; }
  .balance { font-weight: 900; font-size: 14px; }
  .keep-note { font-size: 11.5px; text-align: center; margin-top: 2px; }
  .barcode-wrap { text-align: center; margin: 6px 0; }
  .footer { text-align: center; margin-top: 6px; font-size: 11.5px; }
  .copy-label { font-weight: 900; font-size: 15px; letter-spacing: 0.05em; border: 2px solid #000; padding: 3px 4px; margin: 4px 0; }
  .cut { page-break-before: always; }
</style>
</head>
<body>
${g.map(i).join("")}
  <script>
    ${g.map((o,$)=>`try { JsBarcode('#barcode${$}', ${JSON.stringify(t.orderNo)}, { format: 'CODE128', width: 1.6, height: 34, displayValue: true, fontSize: 13, font: 'Arial', fontOptions: 'bold', margin: 0 }); } catch (e) {}`).join(`
    `)}
  <\/script>
</body>
</html>`;e.document.open(),e.document.write(E),e.document.close(),e.onload=()=>{setTimeout(()=>{e.print(),e.close()},300)}}const b="#1f2a5e",N="#e0583a",X="#111111",T="#5b6075",Z="#d9dbe3",P="'Bebas Neue', Impact, 'Arial Narrow', sans-serif",U="'Arimo', Arial, Helvetica, sans-serif",tt="'Mr Dafoe', 'Brush Script MT', 'Segoe Script', cursive";function c(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function et(e){return e.lineItems.map(t=>{const n=[t.serviceName,t.materialName].filter(Boolean).map(d=>c(d)).join(" + "),l=t.itemType==="per-metre"?"m":"",r=t.heatPressFee?`<div class="disc">+ ${p(t.heatPressFee)} heat press fee/pc</div>`:"",u=[t.discountPct?`${t.discountPct}%`:"",t.discountAmt?`-${p(t.discountAmt)}`:""].filter(Boolean),m=u.length?`<div class="disc">${u.join(" / ")} off</div>`:"";return`
      <tr>
        <td class="qty">${t.qty}${l}</td>
        <td>${n}${r}${m}</td>
        <td class="num">${p(t.unitPrice)}</td>
        <td class="num">${p(t.lineTotal)}</td>
      </tr>`}).join("")}function at(e,t,n){var O,S,z;const l=e.status!=="Quote",r=e.kind==="walkin"&&e.status==="Order",u=r?"RECEIPT":l?"INVOICE":"QUOTATION",m=r?"RECEIPT":l?"INVOICE":"QUOTE",d=l&&e.totals.balanceDue<=0,v=c(t.companyName||""),A=t.logoDataUrl?`<img class="logo" src="${t.logoDataUrl}" alt="${v}" />`:"",a=t.legalName&&t.legalName.trim()&&t.legalName.trim()!==(t.companyName||"").trim()?`<div class="line muted">Trading name of ${c(t.legalName.trim())}</div>`:"",{net:g,vat:i,total:E}=Y(e.totals.grandTotal,M),x=f=>"Ksh "+f.toLocaleString("en-KE",{minimumFractionDigits:2,maximumFractionDigits:2}),o=e.corporateClient,$=e.totals.grandTotal-e.totals.balanceDue,D=l?[e.dueDate?`Payment is due by ${k(e.dueDate)}.`:"Payment is due on receipt of this invoice.","We accept Cash, M-Pesa, Bank Transfer and Card.","All prices include VAT at 16%."]:["All prices include VAT at 16%.","Production begins once this quotation is accepted — a deposit payment turns it into an invoice.","We accept Cash, M-Pesa, Bank Transfer and Card."],C=[t.companyPhone,t.companyPhone2].filter(f=>!!f&&!!f.trim()),j=[...C,t.companyEmail].filter(Boolean).map(f=>c(f)).join(" &middot; "),V=C.length?`<div class="line">Tel: ${C.map(c).join(" &middot; ")}</div>`:"",w=[(O=t.website)!=null&&O.trim()?`Web: ${c(t.website.trim())}`:"",(S=t.facebook)!=null&&S.trim()?`Facebook: ${c(t.facebook.trim())}`:"",(z=t.tiktok)!=null&&z.trim()?`TikTok: ${c(t.tiktok.trim())}`:""].filter(Boolean),F=w.length?`<div class="line">${w.join(" &middot; ")}</div>`:"";return`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${c(e.orderNo)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Arimo:wght@400;700&family=Bebas+Neue&family=Mr+Dafoe&display=swap" rel="stylesheet" />
<style>
  @page { size: A4; margin: 14mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  body { font-family: ${U}; color: ${X}; font-size: 12.5px; margin: 0; background: #fff; }
  h1, h2, .caps { font-family: ${P}; font-weight: 400; margin: 0; color: ${b}; letter-spacing: 0.02em; }

  .sheet { position: relative; min-height: 262mm; display: flex; flex-direction: column; padding: 2mm 2mm 0; }

  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .top h1 { font-size: 76px; line-height: 0.95; letter-spacing: 0.015em; }
  .logo { max-width: 120px; max-height: 96px; object-fit: contain; }

  .company { margin-top: 14px; line-height: 1.55; }
  .company .name { font-weight: 700; font-size: 13px; }
  .line { font-size: 12px; }
  .muted { color: ${T}; }

  .info { display: grid; grid-template-columns: 1fr 1fr 1.1fr; gap: 22px; margin-top: 26px; }
  .info h2 { font-size: 21px; margin-bottom: 3px; }
  .info .who { line-height: 1.5; font-size: 12px; }
  .meta { display: grid; grid-template-columns: auto 1fr; column-gap: 14px; row-gap: 3px; align-items: baseline; }
  .meta .k { font-family: ${P}; color: ${b}; font-size: 21px; line-height: 1.15; letter-spacing: 0.02em; }
  .meta .v { text-align: right; font-size: 12px; }

  table { width: 100%; border-collapse: collapse; margin-top: 26px; }
  thead tr { border-top: 2px solid ${N}; border-bottom: 2px solid ${N}; }
  th { font-family: ${P}; font-weight: 400; color: ${b}; font-size: 21px; letter-spacing: 0.02em; padding: 5px 8px 3px; text-align: center; }
  th.l { text-align: left; }
  th.r, td.num { text-align: right; }
  td { padding: 9px 8px; font-size: 12px; vertical-align: top; border-bottom: 1px solid ${Z}; }
  td.qty { text-align: center; width: 70px; }
  tbody tr:last-child td { border-bottom: 2px solid ${N}; }
  .disc { font-size: 10px; color: ${T}; margin-top: 2px; }

  .totals { margin: 16px 0 0 auto; width: 340px; }
  .totals .row { display: flex; justify-content: space-between; padding: 4px 8px; font-size: 12px; }
  .totals .row.small { font-size: 10.5px; color: ${T}; padding-top: 0; }
  .totals .total { display: flex; justify-content: space-between; align-items: baseline; padding: 6px 8px 0; }
  .totals .total span { font-family: ${P}; color: ${b}; font-size: 28px; letter-spacing: 0.02em; }
  .totals .total em { font-family: ${U}; font-style: normal; font-size: 11px; color: ${T}; letter-spacing: 0; }
  .totals .due span { color: ${N}; }
  .status { margin: 8px 8px 0; text-align: right; font-family: ${P}; font-size: 20px; color: ${b}; letter-spacing: 0.04em; }
  .status.due { color: ${N}; }
  .payments { margin: 4px 8px 0; font-size: 10.5px; color: ${T}; }
  .payments div { display: flex; justify-content: space-between; padding: 1px 0; }

  .foot { margin-top: auto; padding-top: 40px; display: flex; justify-content: flex-end; align-items: flex-end; gap: 22px; }
  .thanks { font-family: ${tt}; color: ${b}; font-size: 58px; line-height: 1; padding-bottom: 6px; white-space: nowrap; }
  .terms { border-left: 2px solid ${b}; padding: 2px 0 2px 16px; width: 290px; }
  .terms h2 { color: ${N}; font-size: 20px; margin-bottom: 8px; }
  .terms p { margin: 0 0 7px; font-size: 11.5px; line-height: 1.4; }
  .terms .contact { color: ${T}; font-size: 10.5px; }

  .watermark {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-32deg);
    font-family: ${P}; font-size: 190px; letter-spacing: 0.08em; color: ${b}; opacity: 0.07;
    z-index: 0; pointer-events: none; white-space: nowrap;
  }
</style>
</head>
<body>
  ${d?'<div class="watermark">PAID</div>':""}
  <div class="sheet">
    <div class="top">
      <div><h1>${u}</h1></div>
      ${A}
    </div>

    <div class="company">
      <div class="name">${v}</div>
      ${a}
      ${t.companyAddress?`<div class="line">${c(t.companyAddress)}</div>`:""}
      ${V}
      ${F}
    </div>

    <div class="info">
      <div>
        <h2>BILL TO</h2>
        <div class="who">
          ${c((o==null?void 0:o.name)||e.customerName||(e.kind==="walkin"?_:"—"))}
          ${o!=null&&o.contactPerson?`<br/>Attn: ${c(o.contactPerson)}`:""}
          ${o!=null&&o.phone||e.phone?`<br/>${c((o==null?void 0:o.phone)||e.phone||"")}`:""}
          ${o!=null&&o.email?`<br/>${c(o.email)}`:""}
        </div>
      </div>
      <div>
        <h2>PREPARED BY</h2>
        <div class="who">
          ${c(e.staff.name)}
          ${j?`<br/>${j}`:""}
        </div>
      </div>
      <div class="meta">
        <span class="k">${m} #</span><span class="v">${c(e.orderNo)}</span>
        <span class="k">${m} DATE</span><span class="v">${I(e.createdDate,e.capturedAt)}</span>
        ${l&&e.dueDate?`<span class="k">DUE DATE</span><span class="v">${k(e.dueDate)}</span>`:""}
        ${!l&&e.validUntil?`<span class="k">VALID UNTIL</span><span class="v">${k(e.validUntil)}</span>`:""}
      </div>
    </div>

    <table>
      <thead>
        <tr><th>QTY</th><th class="l">DESCRIPTION</th><th class="r">UNIT PRICE</th><th class="r">AMOUNT</th></tr>
      </thead>
      <tbody>${et(e)}</tbody>
    </table>

    <div class="totals">
      <div class="row"><span>Subtotal (Incl. VAT)</span><span>${x(e.totals.subtotal)}</span></div>
      ${e.totals.orderDiscount>0?`<div class="row"><span>Discount</span><span>-${x(e.totals.orderDiscount)}</span></div>`:""}
      <div class="row small"><span>Total excluding VAT</span><span>${x(g)}</span></div>
      <div class="row"><span>VAT @${Math.round(M*100)}%</span><span>${x(i)}</span></div>
      <div class="total"><span>${l?"TOTAL DUE":"TOTAL"}</span><span>${x(E)}</span></div>
      ${l?`${e.payments.length?`<div class="payments">${e.payments.map(f=>`<div><span>Paid ${k(f.date)} &middot; ${c(f.method)}</span><span>${p(f.amount)}</span></div>`).join("")}</div>`:""}
            ${e.totals.balanceDue>.009?`<div class="total due"><span>BALANCE DUE</span><span>${x(e.totals.balanceDue)}</span></div>`:""}
            <div class="status ${d?"":"due"}">${d?"PAID IN FULL":e.totals.balanceDue>.009&&$<=.009?"PAYMENT DUE":""}</div>`:""}
    </div>

    <div class="foot">
      <div class="thanks">Thank you</div>
      <div class="terms">
        <h2>TERMS &amp; CONDITIONS</h2>
        ${D.map(f=>`<p>${c(f)}</p>`).join("")}
        ${j?`<p class="contact">${j}</p>`:""}
        ${w.length?`<p class="contact">${w.join("<br/>")}</p>`:""}
      </div>
    </div>
  </div>
</body>
</html>`}function st(e,t,n,l){if(!e)return;const r=at(t,n);e.document.open(),e.document.write(r),e.document.close(),e.onload=()=>{var m;(((m=e.document.fonts)==null?void 0:m.ready)??Promise.resolve()).then(()=>{e.print(),e.close()})}}function dt(e,t,n,l){t.kind==="walkin"?J(e,t,n):st(e,t,n)}const nt=["Cash","M-Pesa","Bank Transfer","Card"];let it=1;const B=(e="Cash",t="")=>({key:it++,method:e,amount:t,reference:"",confirmed:!1}),y=e=>Number(e)||0,H=e=>e.reduce((t,n)=>t+y(n.amount),0);function rt(e,t){const n=H(e);if(n>t+.01)return`The payments add up to ${p(n)}, more than the ${p(t)} due`;for(const l of e)if(y(l.amount)>0&&l.method==="M-Pesa"&&!l.confirmed&&!l.reference.trim())return"Enter the M-Pesa receipt code (or send an STK push) for the M-Pesa part";return null}function mt(e){return e.filter(t=>y(t.amount)>0).map(t=>({method:t.method,amount:y(t.amount),reference:t.reference.trim()||null}))}function ft({rows:e,onChange:t,total:n,phone:l,onPhoneChange:r,accountReference:u}){const m=H(e),d=Math.max(0,n-m),v=(a,g)=>t(e.map(i=>i.key===a?{...i,...g}:i));function A(){const a=String(Math.round(d*100)/100),g=e.find(i=>y(i.amount)===0&&!i.confirmed);t(g?e.map(i=>i.key===g.key?{...i,method:"M-Pesa",amount:a,reference:"",confirmed:!1}:i):[...e,B("M-Pesa",a)])}return s.jsxs("div",{style:{display:"flex",flexDirection:"column",gap:"var(--space-3)"},children:[e.map((a,g)=>s.jsxs("div",{style:{border:"1px solid var(--color-divider)",padding:"var(--space-3)",display:"grid",gridTemplateColumns:"1.1fr 1fr 1.3fr auto",gap:"var(--space-3)",alignItems:"end"},children:[s.jsxs("div",{className:"field",children:[s.jsx("label",{children:e.length>1?`Payment ${g+1} — method`:"Method"}),s.jsx("select",{className:"input",value:a.method,onChange:i=>v(a.key,{method:i.target.value,confirmed:!1,reference:""}),children:nt.map(i=>s.jsx("option",{children:i},i))})]}),s.jsxs("div",{className:"field",children:[s.jsx("label",{children:"Amount (Ksh)"}),s.jsx("input",{className:"input",inputMode:"decimal",value:a.amount,onChange:i=>v(a.key,{amount:i.target.value,confirmed:!1}),placeholder:"0"})]}),s.jsxs("div",{className:"field",children:[s.jsx("label",{children:a.method==="M-Pesa"?"M-Pesa receipt code":a.method==="Cash"?"Reference (optional)":"Slip / reference (optional)"}),s.jsx("input",{className:"input",value:a.reference,onChange:i=>v(a.key,{reference:i.target.value.toUpperCase(),confirmed:!1}),placeholder:a.method==="M-Pesa"?"e.g. SGH1A2B3C4":"",disabled:a.method==="Cash"})]}),s.jsxs("div",{style:{display:"flex",gap:"var(--space-2)"},children:[d>0&&y(a.amount)===0&&s.jsx("button",{type:"button",className:"btn btn-ghost btn-sm",onClick:()=>v(a.key,{amount:String(Math.round(d*100)/100)}),children:"Rest"}),e.length>1&&s.jsx("button",{type:"button",className:"btn btn-ghost btn-sm",onClick:()=>t(e.filter(i=>i.key!==a.key)),"aria-label":"Remove this payment",children:"✕"})]}),a.method==="M-Pesa"&&y(a.amount)>0&&s.jsxs("div",{style:{gridColumn:"1 / -1"},children:[r&&!a.confirmed&&s.jsxs("div",{className:"field",style:{maxWidth:240,marginBottom:"var(--space-2)"},children:[s.jsx("label",{children:"Customer’s M-Pesa number"}),s.jsx("input",{className:"input",inputMode:"tel",placeholder:"07xx xxx xxx",value:l??"",onChange:i=>r(i.target.value),"aria-label":"Customer’s M-Pesa number"})]}),a.confirmed?s.jsxs("span",{className:"tag tag-accent",children:["M-Pesa payment confirmed",a.reference?` (${a.reference})`:""]}):s.jsxs(s.Fragment,{children:[s.jsx(K,{phone:l||"",amount:y(a.amount),accountReference:u||"Order",description:"Order payment",onSuccess:i=>v(a.key,{confirmed:!0,reference:i||a.reference})}),s.jsx("p",{className:"note",style:{marginTop:"var(--space-2)"},children:l?"Or type the receipt code from the customer’s M-Pesa SMS above — it is how the payment is matched to your M-Pesa statement.":"No phone number, so no STK push — type the receipt code from the customer’s M-Pesa SMS above."})]})]})]},a.key)),s.jsxs("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",gap:"var(--space-3)",flexWrap:"wrap"},children:[e.length<6?s.jsx("button",{type:"button",className:"btn btn-secondary btn-sm",onClick:()=>t([...e,B(e.some(a=>a.method==="Cash")?"M-Pesa":"Cash")]),children:"+ Add another method"}):s.jsx("span",{}),s.jsx("button",{type:"button",className:"btn btn-secondary btn-sm",disabled:d<=.01,onClick:A,title:"Ask the customer to pay what is due by M-Pesa: a prompt goes to their phone",children:"📲 Pay by M-Pesa STK push"}),s.jsxs("span",{style:{fontSize:13},children:["Paying now ",s.jsx("strong",{children:p(m)})," · ",n-m>.01?s.jsxs(s.Fragment,{children:["balance after this ",s.jsx("strong",{children:p(d)})]}):"settled in full"]})]})]})}export{ft as S,M as V,dt as a,H as b,st as c,B as n,rt as p,mt as t};
