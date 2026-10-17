// Synthetic CSV text. Workerd has no file system, so fixtures are strings, not .csv files.

export const subscribersCsv = [
	"email,signup_date,status,acquisition_source,last_open_date",
	" A@x.com,2026-08-10,active,Instagram,2026-09-01",
	"a@x.com ,2026-08-12,active,Instagram,2026-09-20",
	"b@x.com,2026-09-10,active,twitter,",
	"c@x.com,2026-07-01,unsubscribed,,2026-07-15",
	"d.o'brien+tag@x.com,2026-08-20,active,Google,2026-09-02",
	"not-an-email,2026-08-20,active,Google,2026-09-02",
	",,,,",
	" , , , , ",
].join("\n");

export const appUsersCsv = [
	"user_id,email,created_at",
	"u_match,C@X.com,2026-08-22",
	"u_only,  New@Y.com ,2026-09-01",
	"u_only2,new@y.com,2026-09-02",
].join("\n");

export const webEventsCsv = [
	"visitor_id,page,timestamp,utm_source,email",
	"v_1,/news/a,2026-08-01 10:00:00,Twitter,",
	"v_1,/news/b,2026-08-02 11:00:00,twitter,  B@X.com",
	"v_1,/news/c,2026-08-03 12:00:00,,",
	"v_2,/home,2026-08-05 09:00:00,instagram,",
	"v_3,/news/a,2026-08-06 09:00:00,google,ghost@nowhere.com",
	"v_1,/news/a,2026-08-01 10:00:00,Twitter,",
].join("\n");
