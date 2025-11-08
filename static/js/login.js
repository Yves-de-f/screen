document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const errorMessageDiv = document.getElementById('error-message');

    // Display initial errors passed from the server via URL query parameters
    const urlParams = new URLSearchParams(window.location.search);
    const error = urlParams.get('error');
    if (error) {
        errorMessageDiv.textContent = error;
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault(); // Prevent the default form submission

        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;

        errorMessageDiv.textContent = ''; // Clear previous errors

        try {
            const response = await fetch('/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username, password }),
            });

            if (response.ok) {
                // Login successful, the backend sets a cookie.
                // Redirect to the main page.
                window.location.href = '/';
            } else {
                // Login failed, display error message from the server
                const data = await response.json();
                errorMessageDiv.textContent = data.error || 'Login failed. Please try again.';
            }
        } catch (err) {
            console.error('Login request failed:', err);
            errorMessageDiv.textContent = 'An error occurred. Please check the console and try again.';
        }
    });
});