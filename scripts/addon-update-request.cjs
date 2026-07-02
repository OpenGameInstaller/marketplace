const addonRequest = require('./addon-request.cjs');
module.exports = addonRequest;

if (require.main === module) {
  const fs = require('fs');
  const command = process.argv[2];
  const body = process.env.ISSUE_BODY || fs.readFileSync(0, 'utf8');
  const options = {
    banned: process.env.REQUESTER_BANNED === 'true',
    trusted: process.env.REQUESTER_TRUSTED === 'true',
    user: process.env.REQUESTER_LOGIN || '',
  };

  if (command === 'validate') {
    process.stdout.write(JSON.stringify(addonRequest.validateUpdate(body, options)));
  } else if (command === 'apply') {
    process.stdout.write(JSON.stringify(addonRequest.applyUpdate(body)));
  } else if (command === 'bump') {
    process.stdout.write(addonRequest.replaceTargetRef(body, process.env.BUMP_REF || process.argv[3] || ''));
  } else {
    throw new Error('Usage: addon-update-request.cjs <validate|apply|bump>');
  }
}
