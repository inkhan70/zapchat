// CONFIGURATION: Pointing directly to your live Back4App instance
const BACKEND_URL = "https://echochat-m8tjh7ss.b4a.run"; 

document.addEventListener("DOMContentLoaded", () => {
    console.log("ZapChat Frontend Initialized Successfully.");

    // DOM Elements
    const signInTab = document.getElementById("auth-signin-tab");
    const signUpTab = document.getElementById("auth-signup-tab");
    const authTitle = document.getElementById("auth-title");
    const authSubmitBtn = document.getElementById("auth-submit-btn");
    const authForm = document.getElementById("auth-form");

    let isSignUpMode = false;

    // Tab Switching Logic
    if (signInTab && signUpTab) {
        signInTab.addEventListener("click", () => {
            isSignUpMode = false;
            signInTab.classList.add("active");
            signUpTab.classList.remove("active");
            authTitle.textContent = "Sign In";
            authSubmitBtn.innerHTML = 'Sign In <span class="arrow">→</span>';
        });

        signUpTab.addEventListener("click", () => {
            isSignUpMode = true;
            signUpTab.classList.add("active");
            signInTab.classList.remove("active");
            authTitle.textContent = "Create Account";
            authSubmitBtn.innerHTML = 'Sign Up <span class="arrow">→</span>';
        });
    }

    // Form Submission Handling (Using standard browser fetch)
    if (authForm) {
        authForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            
            const usernameInput = document.getElementById("username-input")?.value.trim();
            const passwordInput = document.getElementById("password-input")?.value.trim();

            if (!usernameInput || !passwordInput) {
                alert("Please fill in all fields.");
                return;
            }

            const endpoint = isSignUpMode ? "/api/auth/register" : "/api/auth/login";
            
            try {
                authSubmitBtn.disabled = true;
                authSubmitBtn.textContent = "Processing...";

                const response = await fetch(`${BACKEND_URL}${endpoint}`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ username: usernameInput, password: passwordInput })
                });

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.message || "Authentication failed");
                }

                alert(isSignUpMode ? "Registration Successful! Please Sign In." : "Logged in successfully!");
                if (!isSignUpMode && data.token) {
                    localStorage.setItem("token", data.token);
                }

            } catch (error) {
                console.error("Authentication Error:", error);
                alert(error.message);
            } finally {
                authSubmitBtn.disabled = false;
                authSubmitBtn.innerHTML = isSignUpMode ? 'Sign Up <span class="arrow">→</span>' : 'Sign In <span class="arrow">→</span>';
            }
        });
    }
});
