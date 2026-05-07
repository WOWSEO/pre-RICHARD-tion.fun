/**
 * v42 — site footer with social links and legal page navigation.
 * Helps with dApp legitimacy signals (Phantom Blowfish heuristics
 * weight presence of contact + legal pages).
 *
 * The legal page links are anchor jumps to in-page sections rendered
 * by Legal.tsx — no router required.
 */
interface FooterProps {
  onShowLegal: (page: "tos" | "privacy" | "about") => void;
}

export function Footer({ onShowLegal }: FooterProps) {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-links">
          <a
            href="https://x.com/Banyan_Builds"
            target="_blank"
            rel="noopener noreferrer"
          >
            Twitter
          </a>
          <a
            href="https://t.me/pre_RICHARD_tion"
            target="_blank"
            rel="noopener noreferrer"
          >
            Telegram
          </a>
          <a href="mailto:contact@pre-richard-tion.fun">Contact</a>
        </div>
        <div className="site-footer-legal">
          <button type="button" onClick={() => onShowLegal("about")}>
            About
          </button>
          <button type="button" onClick={() => onShowLegal("tos")}>
            Terms
          </button>
          <button type="button" onClick={() => onShowLegal("privacy")}>
            Privacy
          </button>
        </div>
      </div>
    </footer>
  );
}
