(function (global) {
  const ATTRIBUTE_TYPES = {
    postalcode: 'data-nladdressjs-postalcode',
    number: 'data-nladdressjs-number',
    street: 'data-nladdressjs-street',
    city: 'data-nladdressjs-city',
    country: 'data-nladdressjs-country'
  };

  const FETCH_FIELDS = {
    street: ['straat'],
    city: ['woonplaats', 'gemeente'],
    country: ['land', 'country'],
    postalcode: ['postcode'],
    number: ['huisnummer']
  };

  const REQUIRED_ATTRIBUTES = ['postalcode', 'number'];

  const API_ENDPOINT = 'https://json.api-postcode.nl';

  const groups = new Map();

  function normaliseValue(value) {
    return (value || '').toString().trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function createGroup(id) {
    return {
      id,
      elements: {},
      listeners: new Map(),
      debounceTimer: null,
      pendingRequest: null,
      lastQuery: null,
      isUpdating: false,
      lastDeclinedSignature: null
    };
  }

  function getGroup(id) {
    if (!groups.has(id)) {
      groups.set(id, createGroup(id));
    }

    return groups.get(id);
  }

  function getTypeForElement(element) {
    return Object.entries(ATTRIBUTE_TYPES).find(([, attr]) => element.hasAttribute(attr))?.[0] || null;
  }

  function registerElement(element) {
    if (!(element instanceof Element)) {
      return;
    }

    const id = element.getAttribute('data-nladdressjs-id');

    if (!id) {
      return;
    }

    const type = getTypeForElement(element);

    if (!type) {
      return;
    }

    const group = getGroup(id);

    if (group.elements[type] === element) {
      return;
    }

    group.elements[type] = element;

    if (!group.listeners.has(element)) {
      const handler = (event) => handleKeyup(event, group.id);
      element.addEventListener('keyup', handler);
      group.listeners.set(element, handler);
    }

    // trigger initial lookup when both required fields are present and filled
    maybeTriggerLookup(group.id);
  }

  function scanForElements(root = document.body) {
    if (!root) {
      return;
    }

    const selectors = Object.values(ATTRIBUTE_TYPES).map((attr) => `[${attr}]`).join(', ');

    if (!selectors) {
      return;
    }

    if (root instanceof Element && root.matches(selectors)) {
      registerElement(root);
    }

    root.querySelectorAll(selectors).forEach(registerElement);
  }

  function handleKeyup(event, groupId) {
    if (!event || !event.target) {
      return;
    }

    const group = groups.get(groupId);

    if (!group || group.isUpdating) {
      return;
    }

    maybeTriggerLookup(groupId);
  }

  function maybeTriggerLookup(groupId) {
    const group = groups.get(groupId);

    if (!group) {
      return;
    }

    if (group.debounceTimer) {
      clearTimeout(group.debounceTimer);
    }

    group.debounceTimer = window.setTimeout(() => {
      lookupAddress(groupId);
    }, 250);
  }

  function getElementValue(element) {
    if (!element) {
      return '';
    }

    if ('value' in element) {
      return element.value;
    }

    return element.textContent || '';
  }

  function setElementValue(element, value) {
    if (!element) {
      return;
    }

    if ('value' in element) {
      element.value = value;
    } else {
      element.textContent = value;
    }
  }

  function getFieldValue(type, data) {
    const keys = FETCH_FIELDS[type] || [];

    for (const key of keys) {
      if (key in data && data[key]) {
        return data[key];
      }
    }

    if (type === 'country') {
      return 'Nederland';
    }

    return null;
  }

  function lookupAddress(groupId) {
    const group = groups.get(groupId);

    if (!group || group.isUpdating) {
      return;
    }

    const postalElement = group.elements.postalcode;
    const numberElement = group.elements.number;

    if (!postalElement || !numberElement) {
      return;
    }

    const postalcode = normalisePostalcode(getElementValue(postalElement));
    const number = (getElementValue(numberElement) || '').toString().trim();

    if (!postalcode || !number) {
      return;
    }

    if (!postalcode.match(/^[0-9]{4}[a-z]{2}$/i)) {
      return;
    }

    const querySignature = `${postalcode}|${number}`;

    if (group.pendingRequest && group.pendingRequest.signature === querySignature) {
      return;
    }

    if (group.lastQuery === querySignature) {
      return;
    }

    const controller = new AbortController();
    const signal = controller.signal;

    const url = `${API_ENDPOINT}?postcode=${postalcode}&huisnummer=${number}`;

    const fetchPromise = fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      },
      signal
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Adres lookup mislukt: ${response.status}`);
        }

        return response.json();
      })
      .then((data) => {
        group.lastQuery = querySignature;
        applyAddressData(groupId, data);
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          console.warn('NLAddressJS lookup error', error);
        }
      })
      .finally(() => {
        if (group.pendingRequest && group.pendingRequest.controller === controller) {
          group.pendingRequest = null;
        }
      });

    if (group.pendingRequest) {
      group.pendingRequest.controller.abort();
    }

    group.pendingRequest = { promise: fetchPromise, controller, signature: querySignature };
  }

  function normalisePostalcode(value) {
    return (value || '').toString().replace(/\s+/g, '').toUpperCase();
  }

  function applyAddressData(groupId, data) {
    const group = groups.get(groupId);

    if (!group) {
      return;
    }

    const updates = [];
    const suggestions = [];

    Object.entries(group.elements).forEach(([type, element]) => {
      if (!element) {
        return;
      }

      const fetchedValue = getFieldValue(type, data);

      if (!fetchedValue) {
        return;
      }

      const currentValue = getElementValue(element);

      if (!currentValue) {
        updates.push({ element, value: fetchedValue });
        return;
      }

      if (normaliseValue(currentValue) === normaliseValue(fetchedValue)) {
        return;
      }

      suggestions.push({ type, element, currentValue, value: fetchedValue });
    });

    if (updates.length === 0 && suggestions.length === 0) {
      return;
    }

    group.isUpdating = true;

    try {
      updates.forEach(({ element, value }) => {
        setElementValue(element, value);
      });

      if (suggestions.length > 0) {
        const signature = suggestions
          .map((item) => `${item.type}:${normaliseValue(item.currentValue)}->${normaliseValue(item.value)}`)
          .sort()
          .join('|');

        if (group.lastDeclinedSignature && group.lastDeclinedSignature === signature) {
          return;
        }

        const message = buildConfirmationMessage(suggestions);

        if (window.confirm(message)) {
          suggestions.forEach(({ element, value }) => {
            setElementValue(element, value);
          });
          group.lastDeclinedSignature = null;
        } else {
          group.lastDeclinedSignature = signature;
        }
      }
    } finally {
      group.isUpdating = false;
    }
  }

  function buildConfirmationMessage(suggestions) {
    const lines = suggestions.map((item) => {
      const label = getLabelForType(item.type);
      return `${label}: "${item.currentValue}" → "${item.value}"`;
    });

    return [
      'De gevonden adresgegevens verschillen van de ingevulde waarden.',
      'Wil je het adres automatisch laten corrigeren met de volgende waarden?',
      '',
      ...lines
    ].join('\n');
  }

  function getLabelForType(type) {
    switch (type) {
      case 'postalcode':
        return 'Postcode';
      case 'number':
        return 'Huisnummer';
      case 'street':
        return 'Straat';
      case 'city':
        return 'Plaats';
      case 'country':
        return 'Land';
      default:
        return type;
    }
  }

  function validateRequiredElements() {
    groups.forEach((group) => {
      const missing = REQUIRED_ATTRIBUTES.filter((type) => !group.elements[type]);

      if (missing.length > 0) {
        console.warn(
          `NLAddressJS: groep "${group.id}" mist verplichte elementen: ${missing
            .map((type) => ATTRIBUTE_TYPES[type])
            .join(', ')}`
        );
      }
    });
  }

  function observeDomChanges() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element || node instanceof DocumentFragment) {
            scanForElements(node);
          }
        });
      });
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
  }

  function initialise() {
    scanForElements(document.body || document.documentElement);
    validateRequiredElements();
    observeDomChanges();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialise, { once: true });
  } else {
    initialise();
  }

  global.NLAddressJS = {
    rescan: scanForElements
  };
})(typeof window !== 'undefined' ? window : this);
