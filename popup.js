document.addEventListener('DOMContentLoaded', () => {
  loadData();
  
  document.getElementById('scanBtn').addEventListener('click', () => {
    const btn = document.getElementById('scanBtn');
    const status = document.getElementById('status');
    
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (!tabs[0].url.includes("zepto")) {
        status.textContent = "❌ Go to Zepto Orders page first";
        return;
      }

      btn.disabled = true;
      btn.innerText = "Scanning...";

      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        function: scrapePage
      }, (results) => {
        btn.disabled = false;
        btn.innerText = "🔄 Scan Visible Orders";
        
        if (results && results[0] && results[0].result) {
          const data = results[0].result;
          if (data.length === 0) {
            status.textContent = "⚠️ Found 0 orders. Scroll down!";
          } else {
            saveData(data);
            status.textContent = `✅ Scanned ${data.length} orders.`;
          }
        }
      });
    });
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    if(confirm("Clear history?")) chrome.storage.local.clear(loadData);
  });
});

function saveData(newOrders) {
  chrome.storage.local.get(['expenses'], (result) => {
    const existing = result.expenses || [];
    newOrders.forEach(item => {
      if (!existing.some(e => e.date === item.date && e.price === item.price)) {
        existing.push(item);
      }
    });
    chrome.storage.local.set({ expenses: existing }, loadData);
  });
}

function loadData() {
  chrome.storage.local.get(['expenses'], (result) => {
    const expenses = result.expenses || [];
    if (expenses.length > 0) document.getElementById('results').style.display = 'block';

    // 1. Total
    const total = expenses.reduce((sum, i) => sum + i.price, 0);
    document.getElementById('totalAmount').innerText = '₹' + total.toLocaleString('en-IN');
    document.getElementById('orderCount').innerText = expenses.length + ' Orders';

    // 2. Top Products (Logic: Count occurrences of names)
    const counts = {};
    expenses.forEach(o => {
      o.products.forEach(p => {
        // Clean up name (e.g., "Amul Butter 500g" -> "Amul Butter")
        // This helps group similar items better
        let name = p.split(' ').slice(0, 2).join(' '); 
        counts[name] = (counts[name] || 0) + 1;
      });
    });
    
    const sortedProds = Object.keys(counts).sort((a,b) => counts[b] - counts[a]).slice(0, 5);
    document.getElementById('topList').innerHTML = sortedProds.map(p => `
      <div class="row"><span>${p}</span> <span class="badge">${counts[p]}x</span></div>
    `).join('') || "<div style='text-align:center; color:#999; font-size:11px'>No product images found</div>";

    // 3. Big Orders
    const sortedPrice = [...expenses].sort((a,b) => b.price - a.price).slice(0, 3);
    document.getElementById('bigList').innerHTML = sortedPrice.map(o => `
      <div class="row"><span>${o.date.split(',')[0].replace('Placed at ','')}</span> <b>₹${o.price}</b></div>
    `).join('');
  });
}

// --- THE SCRAPER ---
function scrapePage() {
  const orders = [];
  // Find "Placed at" anchors
  const xpath = "//*[contains(text(), 'Placed at')]";
  const snapshot = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);

  for (let i = 0; i < snapshot.snapshotLength; i++) {
    let dateEl = snapshot.snapshotItem(i);
    let card = dateEl.parentElement;
    let validCard = null;

    // Climb up to find the card with the price
    for(let k=0; k<6; k++) {
       if(!card) break;
       // Check for price
       if(card.innerText.match(/[₹|Rs]\s?[0-9,]+/)) {
          // Ensure it's not the main wrapper (only 1 date allowed in card)
          if((card.innerText.match(/Placed at/g)||[]).length === 1) validCard = card;
       }
       card = card.parentElement;
    }

    if (validCard) {
      const text = validCard.innerText;
      const priceMatch = text.match(/[₹|Rs]\s?([0-9,]+)/);
      const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;
      const date = (text.match(/Placed at\s(.+)/) || [])[0] || "Unknown";

      // EXTRACT PRODUCTS FROM IMAGES
      const products = [];
      validCard.querySelectorAll('img').forEach(img => {
         const alt = (img.alt || "").toLowerCase();
         const src = (img.src || "").toLowerCase();
         // Filter garbage
         if(alt.includes('arrow') || alt.includes('icon') || alt.includes('status') || src.includes('.svg')) return;
         
         if(img.alt && img.alt.length > 1) {
             // Capitalize
             products.push(img.alt.charAt(0).toUpperCase() + img.alt.slice(1));
         }
      });

      if (price > 0) {
        orders.push({ date, price, products });
      }
    }
  }
  return orders;
}
