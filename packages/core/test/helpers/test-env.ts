// Preloaded by `npm test`. Installing or upgrading a module runs its migrations on the module's own database login,
// and the password of that login comes from the master key, so every test that does it needs one. A key set in the
// environment or in .env wins.
process.env.MODUNEXO_MASTER_KEY ??= "test-master-key-test-master-key-test-master-key";
