
(function () {
    "use strict";

    function checkPasswordStrength(password) {
        const value = typeof password === "string" ? password : "";

        const checks = {
            atLeast8Characters: value.length >= 8,
            atLeast12Characters: value.length >= 12,
            atLeast16Characters: value.length >= 16,
            hasLowercase: /[a-z]/.test(value),
            hasUppercase: /[A-Z]/.test(value),
            hasNumber: /[0-9]/.test(value),
            hasSymbol: /[^A-Za-z0-9\s]/.test(value)
        };

        const groups = [
            checks.hasLowercase,
            checks.hasUppercase,
            checks.hasNumber,
            checks.hasSymbol
        ].filter(Boolean).length;

        let score = 0;

        if (checks.atLeast8Characters) score++;
        if (checks.atLeast12Characters) score++;
        if (checks.atLeast16Characters) score++;
        if (groups >= 2) score++;
        if (groups >= 3) score++;
        if (groups === 4) score++;

        let level;
        let message;

        if (score <= 2) {
            level = "Weak";
            message = "Try using a longer password.";
        } else if (score <= 4) {
            level = "Moderate";
            message = "A longer password or more variety may improve it.";
        } else {
            level = "Strong";
            message = "Good password pattern. Avoid reusing passwords.";
        }

        return {
            level: level,
            score: score,
            maximumScore: 6,
            checks: checks,
            message: message
        };
    }

    window.checkPasswordStrength = checkPasswordStrength;

})();
