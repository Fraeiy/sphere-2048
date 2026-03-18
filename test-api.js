#!/usr/bin/env node
/**
 * test-api.js — Quick API testing for the 2048 game server
 * 
 * npm run test-api
 */

const BASE_URL = 'http://localhost:5000';

async function test(name, method, endpoint, body = null) {
  try {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    if (body) options.body = JSON.stringify(body);

    const response = await fetch(`${BASE_URL}${endpoint}`, options);
    const data = await response.json();

    console.log(`\n✅ ${name}`);
    console.log(`   Status: ${response.status}`);
    console.log(`   Response:`, JSON.stringify(data, null, 2));

    return data;
  } catch (err) {
    console.error(`\n❌ ${name}`);
    console.error(`   Error: ${err.message}`);
  }
}

async function runTests() {
  console.log('🎮 2048 Game Server API Tests\n');
  console.log(`Base URL: ${BASE_URL}\n`);

  // Test 1: Treasury Status
  await test('1. Get Sphere Status', 'GET', '/api/sphere-status');

  // Test 2: Connect User
  const connectResult = await test('2. Connect User (alpha1qq8...)', 'POST', '/api/connect', {
    walletId: 'alpha1qq8fy3z8jtzjau7e6dfc8hlmj5e2gdx2qlp0jey'
  });

  if (connectResult?.success) {
    const userId = connectResult.userId;

    // Test 3: Check Balance (should be zero)
    await test('3. Check Balance (before deposit)', 'GET', `/api/balance?userId=${userId}`);

    // Test 4: Simulate Deposit
    await test('4. Simulate Deposit (10 UCT)', 'POST', '/api/verify-deposit', {
      userId,
      senderAddress: 'alpha1qq2xvfypft45u8k9dpw2j74wvhva25k6hy3a0w',
      uct: 10
    });

    // Test 5: Check Balance (should have moves now)
    await test('5. Check Balance (after deposit)', 'GET', `/api/balance?userId=${userId}`);

    // Test 6: Start New Game
    await test('6. Start New Game', 'POST', '/api/new?userId=' + userId);

    // Test 7: Make a Move
    await test('7. Make a Move (left)', 'POST', '/api/move', {
      userId,
      direction: 'left'
    });

    // Test 8: Check Balance (after move should deduct 0.1 UCT)
    await test('8. Check Balance (after move)', 'GET', `/api/balance?userId=${userId}`);

    // Test 9: Submit Score
    await test('9. Submit Final Score', 'POST', '/api/submit-score', {
      userId
    });
  }

  // Test 10: Leaderboard
  await test('10. Get Leaderboard', 'GET', '/api/leaderboard?limit=5');

  console.log('\n✨ Tests completed!\n');
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
