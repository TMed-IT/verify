const siteConfig = /** @type {const} */ ({
  brand: {
    organizationName: "IT部",
    logoPath: "/brand.svg",
  },
  publicInfo: {
    termsUrl: process.env.NEXT_PUBLIC_TERMS_URL ?? "",
    privacyPolicyUrl: process.env.NEXT_PUBLIC_PRIVACY_POLICY_URL ?? "",
  },
  auth: {
    callbackPath: "/auth/verify/callback",
  },
  clients: {
    tmedit: { origin: "https://tmedit.org", secret: "CLIENT_SECRET_MAIN" },
    atnd: { origin: "https://atnd.tmedit.org", secret: "CLIENT_SECRET_ATND" },
    cs: { origin: "https://cs.tmedit.org", secret: "CLIENT_SECRET_CS" },
  },
});

export default siteConfig;
