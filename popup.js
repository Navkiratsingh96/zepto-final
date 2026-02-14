document.addEventListener('DOMContentLoaded', () => {
  loadData();
  
  document.getElementById('scanBtn').addEventListener('click', () => {
    const btn = document.getElementById('scanBtn');
    
    // Check if we are on Zepto
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (!tabs[0].url.includes("zepto")) {
        alert("⚠️ Please open the Zepto Orders page first.");
        return;
      }

      btn.innerText = "⏳ Scanning...";
      btn.disabled = true;

      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        function: scrapeZeptoFinal
      }, (results) => {
        btn.innerText = "🔄 Scan Visible Orders";
        btn.disabled = false;
        
        if (results && results[0] && results[0].result) {
          const count = results[0].result.length;
          if (count === 0) {
            alert("No orders found! \n\nTip: Scroll down firmly to load the history lists.");
          } else {
            processAndSave(results[0].result);
          }
        }
      });
    });
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    if(confirm("Clear all data?")) {
      chrome.storage.local.clear(() => { loadData(); });
    }
  });
});

function processAndSave(scrapedData) {
  chrome.storage.local.get(['expenses'], (result) => {
    const existing = result.expenses || [];
    
    // Merge new data (Filter duplicates using Price + Date)
    scrapedData.forEach(newItem => {
      const isDuplicate = existing.some(ex => 
        ex.date === newItem.date && ex.price === newItem.price
      );
      if (!isDuplicate) {
        existing.push(newItem);
      }
    });

    chrome.storage.local.set({ expenses: existing }, () => {
      loadData();
    });
  });
}

function loadData() {
  chrome.storage.local.get(['expenses'], (result) => {
    renderDashboard(result.expenses || []);
  });
}

function renderDashboard(expenses) {
  if (!expenses || expenses.length === 0) {
    document.getElementById('dashboard').style.display = 'none';
    document.getElementById('statusMsg').style.display = 'block';
    return;
  }

  document.getElementById('dashboard').style.display = 'block';
  document.getElementById('statusMsg').style.display = 'none';
  document.getElementById('badge').innerText = "Active";
  document.getElementById('badge').style.background = "#4caf50";

  // 1. Total Stats
  const total = expenses.reduce((sum, item) => sum + item.price, 0);
  document.getElementById('totalAmount').innerText = '₹' + total.toLocaleString('en-IN');
  document.getElementById('orderCount').innerText = expenses.length + ' Orders';

  // 2. Monthly Chart
  const months = {};
  expenses.forEach(item => {
    // Clean Date: "Placed at 5th Jun 2025..." -> "Jun 2025"
    try {
      // Extract the date part (e.g., "5th Jun 2025")
      let datePart = item.date.replace("Placed at ", "").split(",")[0];
      // Remove ordinal suffixes like st, nd, rd, th (5th -> 5)
      datePart = datePart.replace(/(\d+)(st|nd|rd|th)/, "$1");
      
      const d = new Date(datePart);
      if (!isNaN(d)) {
        const key = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        if (!months[key]) months[key] = 0;
        months[key] += item.price;
      }
    } catch(e) {}
  });

  // Sort Chronologically
  const sortedKeys = Object.keys(months).sort((a,b) => new Date(a) - new Date(b));

  const chartHTML = sortedKeys.map(m => {
    const val = months[m];
    const max = Math.max(...Object.values(months)) || 1;
    const width = (val / max) * 100;
    return `
      <div class="bar-row">
        <div class="bar-label">${m}</div>
        <div class="bar-track">
          <div class="bar-fill" style="width: ${width}%">₹${val.toLocaleString('en-IN')}</div>
        </div>
      </div>
    `;
  }).join('');
  document.getElementById('chartContainer').innerHTML = chartHTML;

  // 3. Top Products
  const productCounts = {};
  expenses.forEach(order => {
    order.products.forEach(pName => {
      if (!productCounts[pName]) productCounts[pName] = 0;
      productCounts[pName]++;
    });
  });

  const sortedProds = Object.keys(productCounts)
    .sort((a,b) => productCounts[b] - productCounts[a])
    .slice(0, 5);

  const prodHTML = sortedProds.map(p => `
    <div class="prod-item">
      <div class="prod-count">${productCounts[p]}x</div>
      <div class="prod-name">${p}</div>
    </div>
  `).join('');
  
  document.getElementById('topProductsList').innerHTML = prodHTML;
}

// === THE FINAL SCRAPER (v7 - ISOLATION MODE) ===
function scrapeZeptoFinal() {
  const orders = [];
  
  // 1. Find all "Placed at" elements specifically (using XPath is precise)
  const xpath = "//*[contains(text(), 'Placed at')]";
  const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);

  for (let i = 0; i < result.snapshotLength; i++) {
    const dateEl = result.snapshotItem(i);
    
    // 2. INTELLIGENT CLIMB: Find the card container
    // We walk UP the parents. We STOP if we hit a container that has MORE than 1 "Placed at".
    // Why? Because if a container has 2+ dates, it's the LIST wrapper, not the CARD.
    let card = dateEl.parentElement;
    let validCard = null;
    let limit = 0;

    while(card && limit < 6) { // Max 6 levels up
       // Count how many times "Placed at" appears in this parent's text
       const text = card.innerText || "";
       const matches = text.match(/Placed at/g);
       
       if (matches && matches.length > 1) {
          // STOP! We went too high. The previous parent was the correct card.
          break; 
       }
       
       // If this parent has a price, mark it as a potential valid card
       if (text.match(/[₹|Rs]\s?([0-9,]+)/)) {
          validCard = card;
       }
       
       card = card.parentElement;
       limit++;
    }

    if (!validCard) continue; // Couldn't find a container with a price? Skip.

    // 3. EXTRACT DATA (From the isolated Valid Card only)
    const cardText = validCard.innerText;

    // Price
    const priceMatch = cardText.match(/[₹|Rs]\s?([0-9,]+)/);
    const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;

    // Date
    const dateMatch = cardText.match(/Placed at\s([^,]+)/);
    const dateStr = dateMatch ? dateMatch[0] : "Unknown";

    // Products (With Strict Blocklist)
    const products = [];
    const images = validCard.querySelectorAll('img');
    images.forEach(img => {
       const alt = (img.alt || "").toLowerCase();
       const src = (img.src || "").toLowerCase();
       
       // Ignore UI icons
       if (alt.includes("arrow") || alt.includes("icon") || alt.includes("status") || 
           alt.includes("delivered") || src.includes(".svg")) return;
       
       if (img.alt && img.alt.length > 2) {
          let name = img.alt.charAt(0).toUpperCase() + img.alt.slice(1);
          products.push(name);
       }
    });

    if (price > 0) {
      orders.push({
        date: dateStr,
        price: price,
        products: products
      });
    }
  }

  return orders;
}
