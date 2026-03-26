"use client";

import { useInView } from "@/hooks/useInView";
import { trackEvent } from "@/lib/analytics";
import styles from "./UseCasesSection.module.css";

const CASES = [
  { icon: "flight", title: "Aviation Tracking", img: "https://lh3.googleusercontent.com/aida-public/AB6AXuDGJLxtPXceR61f5RfhNuEZLY0UuS_Q6bOjsxU9q2RSrSI9imSSt2VbmSDsbDKZlyl3Q_7WgeexDpR1TkJDxppXdzeyuQfdjha1Zli5SPrAZ3L6jO7iVVk238paWEzSJc-hAxChEmx3wkKNj2vDP9LLgce2OfFwYkFp0xNn_Tl_Zr3qk7YSM5ED8BxRx4yG6Z45OXEuKZVe3yAayC20IPLNQjz0maUipdupJ8TyJV1eKlq_JwPkIxIVLLUBogyl0By-Ett7MO3z5Szv" },
  { icon: "directions_boat", title: "Maritime Intelligence", img: "https://lh3.googleusercontent.com/aida-public/AB6AXuCAaJVQvzEc4OtfEJq86LVQAz2IAqZt7tnNd-ZCcj8Q4NOXHnpId7YTxosJxQQljK2ZklCu89TTyn7r4kcuo3yiDLHQUv0c6uq3sdG8dP3yG3ExkyrN0DiHsJC4RvzLSEGh9P9xQ0FdaRWDDKSxjKai1GbEPv1y_gLfWToCXeyb4Bjdw81DffpP_Lc-kT3l6Qx-ki3MKy5Ia5_piPlab5f4X2zNIf6JYjbgXJlApi-RR_rp8S3WEy14lPFWRHXq-eB26V1GquSTXBuX" },
  { icon: "visibility", title: "OSINT & Situational Awareness", img: "https://lh3.googleusercontent.com/aida-public/AB6AXuDPXl1l9pB1LRqG2s8WBHM5OdnqkkxoakqnCtuD5SQqdooewuQ02MRhSF34ze3J7pjzbi1a5PE0YE_sJxmkM7s6o2GDO-myV5aTPkv0wjZsEWoua1nh6MfRb_7l3ZRvSr4KKn0dfXQjvP-cOQaW_LUwOYtxy6baTJkbOVy8b_W03EeAazlj8FPoiXf2NKdkG7Tm7yEJPRwrrMTYQTKKwVJT4mCniu4wIMMNN_XFZvU1IXBpYQ_XBqBHuv6W194DeBOq71lCVb7elGrJ" },
  { icon: "security", title: "Defense & Security", img: "https://lh3.googleusercontent.com/aida-public/AB6AXuDOoOeywNWEGOzxHqVTGWFO_lqkkIUHR5iAkQzE4cFRn-VC0PakyrD1OQaX8f4nCjY_ycKqu0bN5zmQlI_wK0MX_vSFYQf-PsY_53ohROoagDyZ1yiO85Tx-goPLRKWAVaoSXoszuSfm0Fn-t-8fLm3hKAf-zAnB3b9PY-5tMHqgWLEYJQZKekhwQrq7FzqdOc7UvMgjhy8ezMFhs4Ws-_FiVEbVosSYlPe3paQedlfLHZiOndQXJ-wb9jAJYdUZbIPieohuA6uz-wV" },
];

export default function UseCasesSection() {
  const { ref, isVisible } = useInView(0.1);

  return (
    <section
      ref={ref as React.RefObject<HTMLElement & HTMLDivElement>}
      className={`${styles.section} ${isVisible ? styles.visible : ""}`}
    >
      <div className={styles.inner}>
        <h2 className={styles.heading}>Use cases</h2>
        <div className={styles.grid}>
          {CASES.map(({ icon, title, img }, i) => (
            <div
              key={title}
              className={styles.card}
              style={{ "--i": i } as React.CSSProperties}
            >
              <div className={styles.imageWrap}>
                <img src={img} alt={title} className={styles.image} />
              </div>
              <div className={styles.label}>
                <span className={`material-symbols-outlined ${styles.labelIcon}`}>
                  {icon}
                </span>
                <h4 className={styles.labelText}>{title}</h4>
              </div>
            </div>
          ))}
        </div>
        <div className={styles.cta}>
          <a
            href="/waitlist"
            className={styles.ctaBtn}
            onClick={() =>
              trackEvent("cta_click", { label: "Join Waitlist: Use Cases" })
            }
          >
            Join Waitlist
          </a>
        </div>
      </div>
    </section>
  );
}
