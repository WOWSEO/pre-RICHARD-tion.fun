/**
 * v42 — Legal pages overlay.  Three tabs (About, Terms, Privacy) shown in a
 * modal triggered from the footer.  Content is deliberately concise and
 * informational — not legal advice; users should consult counsel for any
 * jurisdiction-specific compliance question.
 *
 * Kept as a single modal rather than separate routes so we don't need to
 * bring in react-router for three short pages.
 */
import { useEffect } from "react";

export type LegalPage = "tos" | "privacy" | "about";

interface LegalProps {
  page: LegalPage | null;
  onClose: () => void;
  onSwitch: (p: LegalPage) => void;
}

export function Legal({ page, onClose, onSwitch }: LegalProps) {
  useEffect(() => {
    if (!page) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [page, onClose]);

  if (!page) return null;

  return (
    <div
      className="legal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="legal-modal">
        <header className="legal-tabs">
          <button
            type="button"
            className={page === "about" ? "active" : ""}
            onClick={() => onSwitch("about")}
          >
            About
          </button>
          <button
            type="button"
            className={page === "tos" ? "active" : ""}
            onClick={() => onSwitch("tos")}
          >
            Terms
          </button>
          <button
            type="button"
            className={page === "privacy" ? "active" : ""}
            onClick={() => onSwitch("privacy")}
          >
            Privacy
          </button>
          <button type="button" className="legal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="legal-content">
          {page === "about" && <AboutContent />}
          {page === "tos" && <TermsContent />}
          {page === "privacy" && <PrivacyContent />}
        </div>
      </div>
    </div>
  );
}

function AboutContent() {
  return (
    <article>
      <h2>About pre-RICHARD-tion.fun</h2>
      <p>
        pre-RICHARD-tion.fun is a permissionless prediction market for $TROLL
        holders. Bet $TROLL or SOL on whether the $TROLL market cap will be
        higher or lower than a target at the close of a 15-minute, hourly, or
        daily window.
      </p>
      <h3>How it works</h3>
      <ol>
        <li>Connect your Solana wallet (Phantom recommended).</li>
        <li>Choose a market window and pick YES or NO.</li>
        <li>Choose your bet currency ($TROLL or SOL) and amount.</li>
        <li>Sign the on-chain deposit transaction. Your stake is escrowed.</li>
        <li>
          When the market closes, an oracle median (DexScreener and
          GeckoTerminal) determines the settlement market cap. Winners are paid
          out automatically in SOL — no manual claims required.
        </li>
      </ol>
      <h3>Fees</h3>
      <p>
        A 3% platform fee is applied to gross payouts. The remainder is
        transferred directly to the winning wallet on-chain.
      </p>
      <h3>Settlement integrity</h3>
      <p>
        Markets settle based on a median across multiple oracle snapshots taken
        in the close window. If too few snapshots are available, the market
        voids and all stakes are refunded. Markets with only one-sided volume
        also void on no-opposition.
      </p>
    </article>
  );
}

function TermsContent() {
  return (
    <article>
      <h2>Terms of Use</h2>
      <p>
        By using pre-RICHARD-tion.fun (the "Service"), you agree to these
        terms. The Service is provided "as is," without warranty.
      </p>
      <h3>Eligibility</h3>
      <p>
        You must be of legal age in your jurisdiction to participate in
        wagering or prediction markets. The Service is not available where
        prohibited by law. You are responsible for determining whether your
        use of the Service is lawful in your jurisdiction.
      </p>
      <h3>Risk acknowledgement</h3>
      <p>
        Prediction markets involve financial risk. Outcomes are determined by
        oracle data feeds (DexScreener, GeckoTerminal) and are settled
        on-chain. Stakes committed to a market are non-refundable except in
        the case of a void (insufficient oracle data, no opposition). You may
        lose the full amount of any stake.
      </p>
      <h3>Wallet and custody</h3>
      <p>
        You retain custody of your wallet keys. The Service does not store
        private keys. Stakes are held in on-chain escrow accounts during the
        market lifecycle and disbursed automatically at settlement.
      </p>
      <h3>No financial advice</h3>
      <p>
        Information presented by the Service is not financial, legal, or tax
        advice. Consult a qualified professional for advice specific to your
        circumstances.
      </p>
      <h3>Limitation of liability</h3>
      <p>
        To the maximum extent permitted by law, the operators of the Service
        are not liable for any losses arising from use of the Service,
        including losses caused by oracle failure, network congestion, smart
        contract bugs, or third-party wallet software.
      </p>
      <h3>Changes</h3>
      <p>These terms may be updated. Continued use constitutes acceptance.</p>
    </article>
  );
}

function PrivacyContent() {
  return (
    <article>
      <h2>Privacy Policy</h2>
      <p>
        We collect the minimum data needed to operate the Service.
      </p>
      <h3>What we collect</h3>
      <ul>
        <li>
          Public Solana wallet addresses you connect — used to associate
          on-chain bets and payouts with your session.
        </li>
        <li>
          On-chain transaction signatures — public by nature.
        </li>
        <li>
          Standard server logs (IP address, user agent, request paths) —
          retained briefly for operational and abuse-prevention purposes.
        </li>
      </ul>
      <h3>What we don't collect</h3>
      <ul>
        <li>Private keys or seed phrases (the Service never has access).</li>
        <li>Personal identifiers like name, address, or email (unless you contact us).</li>
        <li>Behavioral tracking cookies or third-party analytics SDKs.</li>
      </ul>
      <h3>Sharing</h3>
      <p>
        We do not sell user data. Wallet addresses and transaction signatures
        are public on the Solana blockchain by design and visible to anyone
        running a node.
      </p>
      <h3>Third-party services</h3>
      <p>
        The Service uses DexScreener and GeckoTerminal as price oracles, and
        Helius and Jupiter for RPC and price feeds. These services may log
        request metadata per their own privacy policies.
      </p>
      <h3>Contact</h3>
      <p>
        Questions about this policy:{" "}
        <a href="mailto:contact@pre-richard-tion.fun">
          contact@pre-richard-tion.fun
        </a>
      </p>
    </article>
  );
}
