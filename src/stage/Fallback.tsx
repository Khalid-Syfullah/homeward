import { chapters, site } from "@/content/story";
import styles from "./Fallback.module.css";

/**
 * What the page shows with JavaScript off: the poster, then the ten captions as a readable list, then
 * the closing line. It is plain server-rendered HTML. With scripts on it stays out of sight
 * (display none, so it is also out of the accessibility tree), and the <noscript> rule in the layout
 * (src/app/layout.tsx) is what brings it in and takes the empty film away.
 */
export function Fallback() {
  const link = site.end.link;
  return (
    <article className={styles.fallback} data-fallback aria-label={site.wordmark}>
      <header className={styles.header}>
        <p className={styles.wordmark}>{site.wordmark}</p>
        <p className={styles.note}>{site.a11y.noScript}</p>
      </header>
      {/* eslint-disable-next-line @next/next/no-img-element -- plain markup, it has to work with no scripts */}
      <img className={styles.poster} src={site.poster.src} alt={site.poster.alt} width={1920} height={1080} />
      <ol className={styles.list}>
        {chapters.map((c) => (
          <li key={c.id} className={styles.item}>
            <h2 className={styles.title}>{c.caption.title}</h2>
            <p className={styles.line}>{c.caption.line}</p>
          </li>
        ))}
      </ol>
      <footer className={styles.end}>
        <h2 className={styles.title}>{site.end.heading}</h2>
        <p className={styles.line}>{site.end.line}</p>
        {link.href !== "#" && link.href !== "" ? (
          <p className={styles.line}>
            <a href={link.href}>{link.label}</a>
          </p>
        ) : null}
      </footer>
    </article>
  );
}
