/** The sign-in form. `failed` shows "Wrong password."; `message` shows its own plain text instead. */
export function loginPage(failed: boolean, status = 200, message?: string, headers: HeadersInit = {}): Response {
	const notice = message ?? (failed ? "Wrong password." : "");
	const line = notice === "" ? "" : `<p class="error" role="alert">${notice}</p>`;
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sign in</title>
<link rel="stylesheet" href="/login.css">
</head>
<body>
<main>
<h1>TPO CDP</h1>
<form method="post" action="/login">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Sign in</button>
${line}
</form>
</main>
</body>
</html>
`;
	return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
}
