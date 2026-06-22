// CONFIGURATION: Points directly to your active Back4App server instance
const BACKEND_URL = "https://echochat-m8tjh7ss.b4a.run"; 

document.addEventListener("DOMContentLoaded", () => {
    console.log("ZapChat Frontend Initialized Successfully via ES Modules.");

    // DOM Elements
    const signInTab = document.getElementById("auth-signin-tab");
    const signUpTab = document.getElementById("auth-signup-tab");
    const authTitle = document.getElementById("auth-title");
    const authSubmitBtn = document.getElementById("auth-submit-btn");
    const authForm = document.getElementById("auth-form");

    let isSignUpMode = false;

    // Tab Switching Layout Logic
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

    // Authentication Form Submission Handling
    if (authForm) {
        authForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            
            const usernameInput = document.getElementById("username-input")?.value.trim();
            const passwordInput = document.getElementById("password-input")?.value.trim();

            if (!usernameInput || !passwordInput) {
                alert("Please fill in all fields.");
                return;
            }

            // ✅ FIXED: Routes matched directly to your index.js backend definitions
            const endpoint = isSignUpMode ? "/api/register" : "/api/login";
            
            try {
                // Disable button and provide visual feedback during processing
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
                    throw new Error(data.error || data.message || "Authentication failed");
                }

                alert(isSignUpMode ? "Registration Successful! Please Sign In." : "Logged in successfully!");
                
                if (!isSignUpMode && data.token) {
                    // Secure token storage for subsequent authenticated requests
                    localStorage.setItem("token", data.token);
                }

            } catch (error) {
                console.error("Authentication Error:", error);
                alert(error.message);
            } finally {
                // Re-enable interface components post-request cycle
                authSubmitBtn.disabled = false;
                authSubmitBtn.innerHTML = isSignUpMode ? 'Sign Up <span class="arrow">→</span>' : 'Sign In <span class="arrow">→</span>';
            }
        });
    }
});

/**
 * ✅ NEW: Secure WebRTC Initialization helper function.
 * Call this function whenever you need to start a video/audio connection stream.
 */
async function initializeSecurePeerConnection() {
    try {
        const token = localStorage.getItem("token");
        // Fetch credentials from your own backend proxy to hide the API Key
        const response = await fetch(`${BACKEND_URL}/api/turn-credentials`, {
            headers: {
                "Authorization": `Bearer ${token}`
            }
        });
        
        if (!response.ok) throw new Error("Could not fetch TURN configuration from server.");
        const iceServers = await response.json();

        // Pass the safe backend response data into the RTCPeerConnection instantiation
        const myPeerConnection = new RTCPeerConnection({
            iceServers: iceServers
        });

        console.log("WebRTC infrastructure bound and initialized securely.");
        return myPeerConnection;
    } catch (error) {
        console.error("Failed to establish secure video lines:", error);
    }
}
