import { Resend } from 'resend'
import * as dotenv from 'dotenv'

// Load .env
dotenv.config()

const apiKey = process.env.RESEND_API_KEY
if (!apiKey) {
  console.error('❌ Missing RESEND_API_KEY in .env')
  process.exit(1)
}

const resend = new Resend(apiKey)

const action = process.argv[2]
const domainName = process.argv[3] || 'alloreai.com'
const domainId = process.argv[3]

async function run() {
  switch (action) {
    case 'add':
      console.log(`➕ Adding domain: ${domainName}...`)
      const addResult = await resend.domains.create({ name: domainName })
      console.log(JSON.stringify(addResult, null, 2))
      break

    case 'list':
      console.log('📋 Listing domains...')
      const listResult = await resend.domains.list()
      console.log(JSON.stringify(listResult, null, 2))
      break

    case 'get':
      if (!domainId) return console.error('❌ Missing domain ID')
      console.log(`🔍 Getting domain: ${domainId}...`)
      const getResult = await resend.domains.get(domainId)
      console.log(JSON.stringify(getResult, null, 2))
      break

    case 'verify':
      if (!domainId) return console.error('❌ Missing domain ID')
      console.log(`✅ Verifying domain: ${domainId}...`)
      const verifyResult = await resend.domains.verify(domainId)
      console.log(JSON.stringify(verifyResult, null, 2))
      break

    case 'remove':
      if (!domainId) return console.error('❌ Missing domain ID')
      console.log(`🗑️ Removing domain: ${domainId}...`)
      const removeResult = await resend.domains.remove(domainId)
      console.log(JSON.stringify(removeResult, null, 2))
      break

    default:
      console.log(`
🚀 Resend Domain Setup Helper
Usage:
  npx tsx scripts/resend-setup.ts add <domain_name>
  npx tsx scripts/resend-setup.ts list
  npx tsx scripts/resend-setup.ts get <domain_id>
  npx tsx scripts/resend-setup.ts verify <domain_id>
  npx tsx scripts/resend-setup.ts remove <domain_id>
`)
  }
}

run().catch(console.error)
