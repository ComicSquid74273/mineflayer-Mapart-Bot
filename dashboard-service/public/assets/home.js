(function () {
  const loginForm = document.getElementById('homeLoginForm')
  const loginButton = document.getElementById('homeLoginButton')
  const loginStatus = document.getElementById('homeLoginStatus')
  const usernameInput = document.getElementById('homeUsername')
  const passwordInput = document.getElementById('homePassword')
  const supportForm = document.getElementById('homeSupportForm')
  const supportButton = document.getElementById('homeSupportButton')
  const supportStatus = document.getElementById('homeSupportStatus')
  const supportPlan = document.getElementById('supportPlan')

  function setStatus(element, message, type) {
    if (!element) return
    element.textContent = message
    element.classList.toggle('home-status-error', type === 'error')
    element.classList.toggle('home-status-ok', type === 'ok')
  }

  async function requestJson(url, options) {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(options && options.headers ? options.headers : {})
      },
      ...options
    })
    const text = await response.text()
    const body = text ? JSON.parse(text) : null
    if (!response.ok) {
      throw new Error(body?.error || `Request failed: ${response.status}`)
    }
    return body
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      const username = usernameInput.value.trim()
      const password = passwordInput.value
      if (!username || !password) {
        setStatus(loginStatus, 'Enter your operator or admin credentials.', 'error')
        return
      }

      loginButton.disabled = true
      setStatus(loginStatus, 'Checking access...', null)
      try {
        const result = await requestJson('/api/dashboard/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username, password })
        })
        setStatus(loginStatus, 'Access confirmed. Opening dashboard...', 'ok')
        window.location.assign('/')
      } catch (error) {
        passwordInput.value = ''
        setStatus(loginStatus, error.message || 'Login failed.', 'error')
      } finally {
        loginButton.disabled = false
      }
    })
  }

  document.querySelectorAll('[data-plan-choice]').forEach((button) => {
    button.addEventListener('click', () => {
      if (supportPlan) supportPlan.value = button.dataset.planChoice || ''
      document.getElementById('support')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  })

  if (supportForm) {
    supportForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      const formData = new FormData(supportForm)
      const payload = Object.fromEntries(formData.entries())

      supportButton.disabled = true
      setStatus(supportStatus, 'Sending your query...', null)
      try {
        await requestJson('/api/home/support', {
          method: 'POST',
          body: JSON.stringify(payload)
        })
        supportForm.reset()
        setStatus(supportStatus, 'Thanks. TrendVoyage support received your query.', 'ok')
      } catch (error) {
        setStatus(supportStatus, error.message || 'Could not send your query yet.', 'error')
      } finally {
        supportButton.disabled = false
      }
    })
  }
}())
