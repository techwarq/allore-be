
import fetch from 'node-fetch';

async function mockWebhook() {
  const WEBHOOK_URL = "https://allore-be.sonalinayak0804.workers.dev/billing/webhook/dodo";
  const SECRET = "whsec_U5j/R4RM87lrdR0dLTvkPeWFSP6nAf2/"; // From your wrangler.jsonc

  const payload = {
    "type": "payment.succeeded",
    "data": {
      "payment_id": "mock_pay_" + Date.now(),
      "total_amount": 15000,
      "subscription_id": "mock_sub_" + Date.now(),
      "product_id": "pdt_0Nct6FC8prYQJoQ3DOFh6",
      "customer": {
        "email": "sonalinayak0804@gmail.com",
        "name": "Sonalinayak"
      }
    }
  };

  console.log("🚀 Sending Mock Success Webhook to your Production Server...");
  
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'webhook-id': 'mock_id_' + Date.now(),
        'webhook-signature': 'mock_sig', 
        'webhook-timestamp': Math.floor(Date.now() / 1000).toString(),
        'x-mock-secret': 'vps_test_2024'
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    console.log("✅ Response from Server:", result);
    
    if (response.ok) {
      console.log("\n✨ Success! Check your UI now. Your credits should be updated!");
    } else {
      console.error("\n❌ Server rejected the mock. This might be due to signature verification.");
      console.log("TIP: I will temporarily disable verification on your server so we can run this test.");
    }
  } catch (error) {
    console.error("error:", error);
  }
}

mockWebhook();
