import { rlnClient } from './src/rln/client.js';
import { config } from './src/config.js';

const invoice = 'lnbcrt30u1p5w2vj7dpq2pshjmt9de6zqen0wgs8xetjwe5kxetnnp4q0tvyas524ccf5nfh893nvduxfreuesas65jtaxyu3k8xjkuag73jpp5lfdruadwfms3ctztx8zf2t0ffqar9qr6lu7gfjrjy2sfjlkytenssp54hsd2r78nlcffp87zgzhek40c784jnguy3uexz3p79g2gr3juj3q9qyysgqcqpcxqrwz569kqe93nhpejcvnr8hzmuwth2tlgthwccr78nu8cvullkjsqxw632tj2fpt0huy5m8vggr2p2n4pugqzr6hu8s365fgagpkytrqkq2spd4p87g';

console.log('Testing invoice decode with RGB-LN API...\n');
console.log('Invoice:', invoice);
console.log('');

try {
  const decoded = await rlnClient.decode(invoice);
  console.log('Decoded successfully:');
  console.log('Payment Hash:', decoded.payment_hash);
  console.log('Amount (sats):', decoded.amount_sat);
  console.log('Expires At:', decoded.expires_at || 'N/A');
  console.log('\nFull response:', JSON.stringify(decoded, null, 2));
} catch (error) {
  console.error('Error:', error.message);
  console.log('\nNote: Make sure your RGB-LN node is running at:', config.RLN_BASE_URL);
}


