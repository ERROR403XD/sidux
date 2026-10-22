if (!process.env.PROFILE_ROUTE) {
  console.error('PROFILE_ROUTE is required for profile:thread');
  process.exit(1);
}

require('./profile-browser-runtime.cjs');
