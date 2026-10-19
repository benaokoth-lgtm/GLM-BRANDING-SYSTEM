import{a as T,f as d}from"./calc-C9UChJVZ.js";import{L as Y,b as K,j as a,c as B}from"./index-DHdnX0Ft.js";import{W}from"./commission-B8Hvhx8d.js";import{r as N}from"./vendor-BNp2vZT3.js";const F=.16;function q(t){const e=t/(1+F);return{net:e,vat:t-e}}const _=80,G="CUSTOMER COPY",Q="PRODUCTION COPY";function x(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function J(t){return t.lineItems.map(e=>{const s=x([e.serviceName,e.materialName].filter(Boolean).join(" + ").toUpperCase()),c=e.itemType==="per-metre"?"m":"",f=e.heatPressFee?`<div class="disc">+ ${d(e.heatPressFee)} heat press fee/pc</div>`:"",h=e.discountPct||e.discountAmt?`<div class="disc">disc ${e.discountPct}% / ${d(e.discountAmt)}</div>`:"";return`
        <div class="item">
          <div class="item-row"><span>${s}</span><span>${d(e.lineTotal)}</span></div>
          <div class="item-sub">${e.qty}${c} &times; ${d(e.unitPrice)}</div>
          ${f}
          ${h}
        </div>`}).join("")}function X(t,e,s,c){var g;if(!t)return;const f=x((s.companyName||"").toUpperCase()),h=s.legalName&&s.legalName.trim()&&s.legalName.trim()!==(s.companyName||"").trim()?`<div class="tagline">Trading name of ${x(s.legalName.trim())}</div>`:"",u=[s.companyAddress,s.companyPhone,s.companyPhone2].filter(o=>!!o&&!!o.trim()).map(x).join(" &middot; "),p=(g=s.website)!=null&&g.trim()?x(s.website.trim()):"",n=e.lineItems.reduce((o,$)=>o+$.qty,0),{net:l,vat:r}=q(e.totals.grandTotal),C=[G,Q],P=(o,$)=>`<div class="${$>0?"cut":""}">
  <div class="center">
    ${s.logoDataUrl?`<img class="logo" src="${s.logoDataUrl}" alt="" />`:""}
    <div class="brand">${f}</div>
    ${h}
  </div>
  ${u?`<div class="center meta">${u}</div>`:""}
  ${p?`<div class="center meta">${p}</div>`:""}
  <div class="center meta">${e.totals.balanceDue<=0?"RECEIPT — PAID IN FULL":"INVOICE — BALANCE DUE"}</div>
  <div class="center copy-label">${x(o)}</div>
  <hr />
  <div class="row"><span>ORDER NO.</span><span>${x(e.orderNo)}</span></div>
  <div class="row"><span>DATE</span><span>${T(e.createdDate)}</span></div>
  ${e.totals.balanceDue>0&&e.dueDate?`<div class="row"><span>PAY BY</span><span>${T(e.dueDate)}</span></div>`:""}
  <div class="row"><span>CUSTOMER</span><span>${x(e.customerName||"—")}</span></div>
  ${e.phone?`<div class="row"><span>PHONE</span><span>${x(e.phone)}</span></div>`:""}
  <div class="row"><span>SERVED BY</span><span>${x(e.staff.name)}</span></div>
  ${e.capturedByName?`<div class="row"><span>CASHIER</span><span>${x(e.capturedByName)}</span></div>`:""}
  <hr />
  ${J(e)}
  <hr />
  <div class="totals">
    <div class="row"><span>SUBTOTAL</span><span>${d(e.totals.subtotal)}</span></div>
    ${e.totals.orderDiscount>0?`<div class="row"><span>DISCOUNT</span><span>-${d(e.totals.orderDiscount)}</span></div>`:""}
    <div class="row grand"><span>TOTAL</span><span>${d(e.totals.grandTotal)}</span></div>
    <div class="row vat-note"><span>Incl. VAT (16%)</span><span>${d(r)}</span></div>
    <div class="row vat-note"><span>Net amount</span><span>${d(l)}</span></div>
  </div>
  <hr />
  ${e.payments.map(v=>`<div class="row"><span>${T(v.date)} ${x(v.method).toUpperCase()}</span><span>${d(v.amount)}</span></div>`).join("")}
  ${e.totals.balanceDue>0?`<div class="row balance"><span>BALANCE DUE</span><span>${d(e.totals.balanceDue)}</span></div>`:""}
  <hr />
  <div class="keep-note">${e.totals.balanceDue>0?"PAY THE BALANCE AGAINST THIS ORDER NUMBER":"PLEASE KEEP THIS RECEIPT FOR YOUR RECORDS"}</div>
  <div class="keep-note">ITEMS: ${n}</div>
  <div class="barcode-wrap"><svg id="barcode${$}"></svg></div>
  <div class="footer">Thank you for choosing ${f}!</div>
  ${p?`<div class="footer">${p}</div>`:""}
  <div class="footer">${T(e.createdDate)}</div>
</div>`,E=`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${e.orderNo}</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
<style>
  @page { size: ${_}mm auto; margin: 2mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  /* A thermal head burns solid black dots, so thin strokes and grey text break up and fade. Everything is a heavy sans-serif in pure black, with a
     hairline stroke added to thicken the letters — Courier New's fine strokes were what printed faintly. */
  body {
    width: ${_-6}mm; margin: 0 auto; padding: 2mm 1mm;
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
${C.map(P).join("")}
  <script>
    ${C.map((o,$)=>`try { JsBarcode('#barcode${$}', ${JSON.stringify(e.orderNo)}, { format: 'CODE128', width: 1.6, height: 34, displayValue: true, fontSize: 13, font: 'Arial', fontOptions: 'bold', margin: 0 }); } catch (e) {}`).join(`
    `)}
  <\/script>
</body>
</html>`;t.document.open(),t.document.write(E),t.document.close(),t.onload=()=>{setTimeout(()=>{t.print(),t.close()},300)}}const k="#1f2a5e",I="#e0583a",Z="#111111",S="#5b6075",ee="#d9dbe3",R="'Bebas Neue', Impact, 'Arial Narrow', sans-serif",H="'Arimo', Arial, Helvetica, sans-serif",te="'Mr Dafoe', 'Brush Script MT', 'Segoe Script', cursive";function m(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function ae(t){return t.lineItems.map(e=>{const s=[e.serviceName,e.materialName].filter(Boolean).map(p=>m(p)).join(" + "),c=e.itemType==="per-metre"?"m":"",f=e.heatPressFee?`<div class="disc">+ ${d(e.heatPressFee)} heat press fee/pc</div>`:"",h=[e.discountPct?`${e.discountPct}%`:"",e.discountAmt?`-${d(e.discountAmt)}`:""].filter(Boolean),u=h.length?`<div class="disc">${h.join(" / ")} off</div>`:"";return`
      <tr>
        <td class="qty">${e.qty}${c}</td>
        <td>${s}${f}${u}</td>
        <td class="num">${d(e.unitPrice)}</td>
        <td class="num">${d(e.lineTotal)}</td>
      </tr>`}).join("")}function se(t,e,s){var O,L,z;const c=t.status!=="Quote",f=t.kind==="walkin"&&t.status==="Order",h=f?"RECEIPT":c?"INVOICE":"QUOTATION",u=f?"RECEIPT":c?"INVOICE":"QUOTE",p=c&&t.totals.balanceDue<=0,n=m(e.companyName||""),l=e.logoDataUrl?`<img class="logo" src="${e.logoDataUrl}" alt="${n}" />`:"",r=e.legalName&&e.legalName.trim()&&e.legalName.trim()!==(e.companyName||"").trim()?`<div class="line muted">Trading name of ${m(e.legalName.trim())}</div>`:"",{net:C,vat:P,total:E}=Y(t.totals.grandTotal,F),g=i=>"Ksh "+i.toLocaleString("en-KE",{minimumFractionDigits:2,maximumFractionDigits:2}),o=t.corporateClient,$=t.totals.grandTotal-t.totals.balanceDue,v=c?[t.dueDate?`Payment is due by ${T(t.dueDate)}.`:"Payment is due on receipt of this invoice.","We accept Cash, M-Pesa, Bank Transfer and Card.","All prices include VAT at 16%."]:["All prices include VAT at 16%.","Production begins once this quotation is accepted — a deposit payment turns it into an invoice.","We accept Cash, M-Pesa, Bank Transfer and Card."],A=[e.companyPhone,e.companyPhone2].filter(i=>!!i&&!!i.trim()),w=[...A,e.companyEmail].filter(Boolean).map(i=>m(i)).join(" &middot; "),U=A.length?`<div class="line">Tel: ${A.map(m).join(" &middot; ")}</div>`:"",y=[(O=e.website)!=null&&O.trim()?`Web: ${m(e.website.trim())}`:"",(L=e.facebook)!=null&&L.trim()?`Facebook: ${m(e.facebook.trim())}`:"",(z=e.tiktok)!=null&&z.trim()?`TikTok: ${m(e.tiktok.trim())}`:""].filter(Boolean),j=y.length?`<div class="line">${y.join(" &middot; ")}</div>`:"";return`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${m(t.orderNo)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Arimo:wght@400;700&family=Bebas+Neue&family=Mr+Dafoe&display=swap" rel="stylesheet" />
<style>
  @page { size: A4; margin: 14mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  body { font-family: ${H}; color: ${Z}; font-size: 12.5px; margin: 0; background: #fff; }
  h1, h2, .caps { font-family: ${R}; font-weight: 400; margin: 0; color: ${k}; letter-spacing: 0.02em; }

  .sheet { position: relative; min-height: 262mm; display: flex; flex-direction: column; padding: 2mm 2mm 0; }

  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .top h1 { font-size: 76px; line-height: 0.95; letter-spacing: 0.015em; }
  .logo { max-width: 120px; max-height: 96px; object-fit: contain; }

  .company { margin-top: 14px; line-height: 1.55; }
  .company .name { font-weight: 700; font-size: 13px; }
  .line { font-size: 12px; }
  .muted { color: ${S}; }

  .info { display: grid; grid-template-columns: 1fr 1fr 1.1fr; gap: 22px; margin-top: 26px; }
  .info h2 { font-size: 21px; margin-bottom: 3px; }
  .info .who { line-height: 1.5; font-size: 12px; }
  .meta { display: grid; grid-template-columns: auto 1fr; column-gap: 14px; row-gap: 3px; align-items: baseline; }
  .meta .k { font-family: ${R}; color: ${k}; font-size: 21px; line-height: 1.15; letter-spacing: 0.02em; }
  .meta .v { text-align: right; font-size: 12px; }

  table { width: 100%; border-collapse: collapse; margin-top: 26px; }
  thead tr { border-top: 2px solid ${I}; border-bottom: 2px solid ${I}; }
  th { font-family: ${R}; font-weight: 400; color: ${k}; font-size: 21px; letter-spacing: 0.02em; padding: 5px 8px 3px; text-align: center; }
  th.l { text-align: left; }
  th.r, td.num { text-align: right; }
  td { padding: 9px 8px; font-size: 12px; vertical-align: top; border-bottom: 1px solid ${ee}; }
  td.qty { text-align: center; width: 70px; }
  tbody tr:last-child td { border-bottom: 2px solid ${I}; }
  .disc { font-size: 10px; color: ${S}; margin-top: 2px; }

  .totals { margin: 16px 0 0 auto; width: 340px; }
  .totals .row { display: flex; justify-content: space-between; padding: 4px 8px; font-size: 12px; }
  .totals .row.small { font-size: 10.5px; color: ${S}; padding-top: 0; }
  .totals .total { display: flex; justify-content: space-between; align-items: baseline; padding: 6px 8px 0; }
  .totals .total span { font-family: ${R}; color: ${k}; font-size: 28px; letter-spacing: 0.02em; }
  .totals .total em { font-family: ${H}; font-style: normal; font-size: 11px; color: ${S}; letter-spacing: 0; }
  .totals .due span { color: ${I}; }
  .status { margin: 8px 8px 0; text-align: right; font-family: ${R}; font-size: 20px; color: ${k}; letter-spacing: 0.04em; }
  .status.due { color: ${I}; }
  .payments { margin: 4px 8px 0; font-size: 10.5px; color: ${S}; }
  .payments div { display: flex; justify-content: space-between; padding: 1px 0; }

  .foot { margin-top: auto; padding-top: 40px; display: flex; justify-content: flex-end; align-items: flex-end; gap: 22px; }
  .thanks { font-family: ${te}; color: ${k}; font-size: 58px; line-height: 1; padding-bottom: 6px; white-space: nowrap; }
  .terms { border-left: 2px solid ${k}; padding: 2px 0 2px 16px; width: 290px; }
  .terms h2 { color: ${I}; font-size: 20px; margin-bottom: 8px; }
  .terms p { margin: 0 0 7px; font-size: 11.5px; line-height: 1.4; }
  .terms .contact { color: ${S}; font-size: 10.5px; }

  .watermark {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-32deg);
    font-family: ${R}; font-size: 190px; letter-spacing: 0.08em; color: ${k}; opacity: 0.07;
    z-index: 0; pointer-events: none; white-space: nowrap;
  }
</style>
</head>
<body>
  ${p?'<div class="watermark">PAID</div>':""}
  <div class="sheet">
    <div class="top">
      <div><h1>${h}</h1></div>
      ${l}
    </div>

    <div class="company">
      <div class="name">${n}</div>
      ${r}
      ${e.companyAddress?`<div class="line">${m(e.companyAddress)}</div>`:""}
      ${U}
      ${j}
    </div>

    <div class="info">
      <div>
        <h2>BILL TO</h2>
        <div class="who">
          ${m((o==null?void 0:o.name)||t.customerName||(t.kind==="walkin"?W:"—"))}
          ${o!=null&&o.contactPerson?`<br/>Attn: ${m(o.contactPerson)}`:""}
          ${o!=null&&o.phone||t.phone?`<br/>${m((o==null?void 0:o.phone)||t.phone||"")}`:""}
          ${o!=null&&o.email?`<br/>${m(o.email)}`:""}
        </div>
      </div>
      <div>
        <h2>PREPARED BY</h2>
        <div class="who">
          ${m(t.staff.name)}
          ${w?`<br/>${w}`:""}
        </div>
      </div>
      <div class="meta">
        <span class="k">${u} #</span><span class="v">${m(t.orderNo)}</span>
        <span class="k">${u} DATE</span><span class="v">${T(t.createdDate)}</span>
        ${c&&t.dueDate?`<span class="k">DUE DATE</span><span class="v">${T(t.dueDate)}</span>`:""}
        ${!c&&t.validUntil?`<span class="k">VALID UNTIL</span><span class="v">${T(t.validUntil)}</span>`:""}
      </div>
    </div>

    <table>
      <thead>
        <tr><th>QTY</th><th class="l">DESCRIPTION</th><th class="r">UNIT PRICE</th><th class="r">AMOUNT</th></tr>
      </thead>
      <tbody>${ae(t)}</tbody>
    </table>

    <div class="totals">
      <div class="row"><span>Subtotal (Incl. VAT)</span><span>${g(t.totals.subtotal)}</span></div>
      ${t.totals.orderDiscount>0?`<div class="row"><span>Discount</span><span>-${g(t.totals.orderDiscount)}</span></div>`:""}
      <div class="row small"><span>Total excluding VAT</span><span>${g(C)}</span></div>
      <div class="row"><span>VAT @${Math.round(F*100)}%</span><span>${g(P)}</span></div>
      <div class="total"><span>${c?"TOTAL DUE":"TOTAL"}</span><span>${g(E)}</span></div>
      ${c?`${t.payments.length?`<div class="payments">${t.payments.map(i=>`<div><span>Paid ${T(i.date)} &middot; ${m(i.method)}</span><span>${d(i.amount)}</span></div>`).join("")}</div>`:""}
            ${t.totals.balanceDue>.009?`<div class="total due"><span>BALANCE DUE</span><span>${g(t.totals.balanceDue)}</span></div>`:""}
            <div class="status ${p?"":"due"}">${p?"PAID IN FULL":t.totals.balanceDue>.009&&$<=.009?"PAYMENT DUE":""}</div>`:""}
    </div>

    <div class="foot">
      <div class="thanks">Thank you</div>
      <div class="terms">
        <h2>TERMS &amp; CONDITIONS</h2>
        ${v.map(i=>`<p>${m(i)}</p>`).join("")}
        ${w?`<p class="contact">${w}</p>`:""}
        ${y.length?`<p class="contact">${y.join("<br/>")}</p>`:""}
      </div>
    </div>
  </div>
</body>
</html>`}function ne(t,e,s,c){if(!t)return;const f=se(e,s);t.document.open(),t.document.write(f),t.document.close(),t.onload=()=>{var u;(((u=t.document.fonts)==null?void 0:u.ready)??Promise.resolve()).then(()=>{t.print(),t.close()})}}function he(t,e,s,c){e.kind==="walkin"?X(t,e,s):ne(t,e,s)}const ie=3e3,oe=12e3;function le({phone:t,amount:e,accountReference:s,description:c,orderId:f,disabled:h,onSuccess:u}){const[p,n]=N.useState(null),[l,r]=N.useState(null),[C,P]=N.useState(null),[E,g]=N.useState(!1),[o,$]=N.useState(!1),{user:v}=K(),A=(v==null?void 0:v.role)==="Admin"||!!(v!=null&&v.permissions.canManagePayments),[w,U]=N.useState(""),y=N.useRef(null),j=N.useRef(null);N.useEffect(()=>()=>{y.current&&clearInterval(y.current),j.current&&clearTimeout(j.current)},[]);function M(){y.current&&clearInterval(y.current),j.current&&clearTimeout(j.current),y.current=null,j.current=null}async function O(){P(null),r(null),$(!1),g(!0);try{const i=await B.post("/mpesa/stkpush",{phone:t,amount:e,accountReference:s,description:c,orderId:f});n(i.checkoutRequestId),r({status:"Pending",amount:e,mpesaReceipt:null,resultDesc:null}),j.current=setTimeout(()=>$(!0),oe),y.current=setInterval(()=>L(i.checkoutRequestId),ie)}catch(i){P(i instanceof Error?i.message:"Failed to send STK push")}finally{g(!1)}}async function L(i){try{const b=await B.get(`/mpesa/status/${i}`);r(b),b.status==="Success"?(M(),u(b.mpesaReceipt)):(b.status==="Failed"||b.status==="Cancelled")&&M()}catch{}}async function z(){if(p){g(!0),P(null);try{const i=w.trim().toUpperCase();await B.post(`/mpesa/${p}/confirm-manually`,i?{receipt:i}:{}),M(),r(b=>b&&{...b,status:"Success",mpesaReceipt:i||null}),u(i||null)}catch(i){P(i instanceof Error?i.message:"Failed to confirm manually")}finally{g(!1)}}}return(l==null?void 0:l.status)==="Success"?a.jsxs("span",{className:"tag tag-accent",children:["M-Pesa payment received",l.mpesaReceipt?` — ${l.mpesaReceipt}`:""]}):a.jsxs("div",{style:{display:"flex",flexDirection:"column",gap:"var(--space-2)",alignItems:"start"},children:[!p||(l==null?void 0:l.status)==="Failed"||(l==null?void 0:l.status)==="Cancelled"?a.jsxs("button",{type:"button",className:"btn btn-secondary blueprint",onClick:O,disabled:h||E||!t||e<=0,children:[a.jsx("i",{className:"corner tl"}),a.jsx("i",{className:"corner tr"}),a.jsx("i",{className:"corner bl"}),a.jsx("i",{className:"corner br"}),"📲 Send M-Pesa STK push"]}):a.jsxs(a.Fragment,{children:[a.jsx("span",{className:"tag tag-outline",children:"Waiting for customer to complete payment on their phone…"}),o&&A&&a.jsxs("div",{style:{display:"flex",gap:"var(--space-1)",alignItems:"center",flexWrap:"wrap"},children:[a.jsx("input",{className:"input",style:{width:150},value:w,maxLength:10,onChange:i=>U(i.target.value.toUpperCase()),placeholder:"Code from the SMS","aria-label":"M-Pesa confirmation code from the SMS"}),a.jsx("button",{type:"button",className:"btn btn-ghost",style:{fontSize:11},onClick:z,disabled:E,children:"Payment received — mark as paid"})]}),o&&!A&&a.jsx("span",{className:"note",style:{margin:0},children:"Still nothing? If the customer says they have paid, ask a manager to check the till SMS and confirm it."})]}),(l==null?void 0:l.status)==="Failed"&&a.jsx("p",{className:"note",style:{color:"var(--color-error)",margin:0},children:l.resultDesc||"Payment failed or was declined."}),(l==null?void 0:l.status)==="Cancelled"&&a.jsx("p",{className:"note",style:{margin:0},children:"Customer cancelled the prompt."}),C&&a.jsx("p",{className:"note",style:{color:"var(--color-error)",margin:0},children:C})]})}const ce=["Cash","M-Pesa","Bank Transfer","Card"];let re=1;const pe=(t="Cash",e="")=>({key:re++,method:t,amount:e,reference:"",confirmed:!1}),D=t=>Number(t)||0,V=t=>t.reduce((e,s)=>e+D(s.amount),0);function ge(t,e){const s=V(t);if(s>e+.01)return`The payments add up to ${d(s)}, more than the ${d(e)} due`;for(const c of t)if(D(c.amount)>0&&c.method==="M-Pesa"&&!c.confirmed&&!c.reference.trim())return"Enter the M-Pesa receipt code (or send an STK push) for the M-Pesa part";return null}function ve(t){return t.filter(e=>D(e.amount)>0).map(e=>({method:e.method,amount:D(e.amount),reference:e.reference.trim()||null}))}function xe({rows:t,onChange:e,total:s,phone:c,accountReference:f}){const h=V(t),u=Math.max(0,s-h),p=(n,l)=>e(t.map(r=>r.key===n?{...r,...l}:r));return a.jsxs("div",{style:{display:"flex",flexDirection:"column",gap:"var(--space-3)"},children:[t.map((n,l)=>a.jsxs("div",{style:{border:"1px solid var(--color-divider)",padding:"var(--space-3)",display:"grid",gridTemplateColumns:"1.1fr 1fr 1.3fr auto",gap:"var(--space-3)",alignItems:"end"},children:[a.jsxs("div",{className:"field",children:[a.jsx("label",{children:t.length>1?`Payment ${l+1} — method`:"Method"}),a.jsx("select",{className:"input",value:n.method,onChange:r=>p(n.key,{method:r.target.value,confirmed:!1,reference:""}),children:ce.map(r=>a.jsx("option",{children:r},r))})]}),a.jsxs("div",{className:"field",children:[a.jsx("label",{children:"Amount (Ksh)"}),a.jsx("input",{className:"input",inputMode:"decimal",value:n.amount,onChange:r=>p(n.key,{amount:r.target.value,confirmed:!1}),placeholder:"0"})]}),a.jsxs("div",{className:"field",children:[a.jsx("label",{children:n.method==="M-Pesa"?"M-Pesa receipt code":n.method==="Cash"?"Reference (optional)":"Slip / reference (optional)"}),a.jsx("input",{className:"input",value:n.reference,onChange:r=>p(n.key,{reference:r.target.value.toUpperCase(),confirmed:!1}),placeholder:n.method==="M-Pesa"?"e.g. SGH1A2B3C4":"",disabled:n.method==="Cash"})]}),a.jsxs("div",{style:{display:"flex",gap:"var(--space-2)"},children:[u>0&&D(n.amount)===0&&a.jsx("button",{type:"button",className:"btn btn-ghost btn-sm",onClick:()=>p(n.key,{amount:String(Math.round(u*100)/100)}),children:"Rest"}),t.length>1&&a.jsx("button",{type:"button",className:"btn btn-ghost btn-sm",onClick:()=>e(t.filter(r=>r.key!==n.key)),"aria-label":"Remove this payment",children:"✕"})]}),n.method==="M-Pesa"&&D(n.amount)>0&&a.jsx("div",{style:{gridColumn:"1 / -1"},children:n.confirmed?a.jsxs("span",{className:"tag tag-accent",children:["M-Pesa payment confirmed",n.reference?` (${n.reference})`:""]}):a.jsxs(a.Fragment,{children:[a.jsx(le,{phone:c||"",amount:D(n.amount),accountReference:f||"Order",description:"Order payment",onSuccess:r=>p(n.key,{confirmed:!0,reference:r||n.reference})}),a.jsx("p",{className:"note",style:{marginTop:"var(--space-2)"},children:c?"Or type the receipt code from the customer’s M-Pesa SMS above — it is how the payment is matched to your M-Pesa statement.":"No phone number, so no STK push — type the receipt code from the customer’s M-Pesa SMS above."})]})})]},n.key)),a.jsxs("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",gap:"var(--space-3)",flexWrap:"wrap"},children:[t.length<6?a.jsx("button",{type:"button",className:"btn btn-secondary btn-sm",onClick:()=>e([...t,pe(t.some(n=>n.method==="Cash")?"M-Pesa":"Cash")]),children:"+ Add another method"}):a.jsx("span",{}),a.jsxs("span",{style:{fontSize:13},children:["Paying now ",a.jsx("strong",{children:d(h)})," · ",s-h>.01?a.jsxs(a.Fragment,{children:["balance after this ",a.jsx("strong",{children:d(u)})]}):"settled in full"]})]})]})}export{xe as S,F as V,he as a,V as b,ne as c,pe as n,ge as p,ve as t};
