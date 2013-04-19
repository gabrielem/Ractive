var Ractive, _internal;

(function () {

	'use strict';

	var getEl;

	Ractive = function ( options ) {

		var defaults, key;

		// Options
		// -------

		if ( options ) {
			for ( key in options ) {
				if ( options.hasOwnProperty( key ) ) {
					this[ key ] = options[ key ];
				}
			}
		}

		defaults = {
			preserveWhitespace: false,
			append: false,
			twoway: true,
			formatters: {},
			modifyArrays: true
		};

		for ( key in defaults ) {
			if ( defaults.hasOwnProperty( key ) && this[ key ] === undefined ) {
				this[ key ] = defaults[ key ];
			}
		}


		// Initialization
		// --------------

		if ( this.el !== undefined ) {
			this.el = getEl( this.el ); // turn ID string into DOM element
		}

		// Set up event bus
		this._subs = {};

		// Set up cache
		this._cache = {};
		this._cacheMap = {};

		// Set up observers
		this._observers = {};
		this._pendingResolution = [];

		// Create an array for deferred attributes
		this._deferredAttributes = [];

		// If we were given uncompiled partials, compile them
		if ( this.partials ) {
			for ( key in this.partials ) {
				if ( this.partials.hasOwnProperty( key ) ) {
					if ( typeof this.partials[ key ] === 'string' ) {
						if ( !Ractive.compile ) {
							throw new Error( 'Missing Ractive.compile - cannot compile partial "' + key + '". Either precompile or use the version that includes the compiler' );
						}

						this.partials[ key ] = Ractive.compile( this.partials[ key ], this ); // all compiler options are present on `this`, so just passing `this`
					}
				}
			}
		}

		// Compile template, if it hasn't been compiled already
		if ( typeof this.template === 'string' ) {
			if ( !Ractive.compile ) {
				throw new Error( 'Missing Ractive.compile - cannot compile template. Either precompile or use the version that includes the compiler' );
			}

			this.template = Ractive.compile( this.template, this );
		}

		// If the template was an array with a single string member, that means
		// we can use innerHTML - we just need to unpack it
		if ( this.template && ( this.template.length === 1 ) && ( typeof this.template[0] === 'string' ) ) {
			this.template = this.template[0];
		}

		// If passed an element, render immediately
		if ( this.el ) {
			this.render({ el: this.el, append: this.append });
		}
	};



	// Prototype methods
	// =================
	Ractive.prototype = {

		// Render instance to element specified here or at initialization
		render: function ( options ) {
			var el = ( options.el ? getEl( options.el ) : this.el );

			if ( !el ) {
				throw new Error( 'You must specify a DOM element to render to' );
			}

			// Clear the element, unless `append` is `true`
			if ( !options.append ) {
				el.innerHTML = '';
			}

			if ( options.callback ) {
				this.callback = options.callback;
			}

			// Render our *root fragment*
			this.rendered = new _internal.DomFragment({
				model: this.template,
				root: this,
				parentNode: el
			});

			el.appendChild( this.rendered.docFrag );
		},

		// Teardown. This goes through the root fragment and all its children, removing observers
		// and generally cleaning up after itself
		teardown: function () {
			this.rendered.teardown();
		},

		set: function ( keypath, value ) {
			if ( _internal.isObject( keypath ) ) {
				this._setMultiple( keypath );
			} else {
				this._setSingle( keypath, value );
			}

			// Attributes don't reflect changes automatically if there is a possibility
			// that they will need to change again before the .set() cycle is complete
			// - they defer their updates until all values have been set
			while ( this._deferredAttributes.length ) {
				this._deferredAttributes.pop().update().updateDeferred = false;
			}
		},

		_setSingle: function ( keypath, value ) {
			var keys, key, obj, normalised, i, unresolved;

			if ( _internal.isArray( keypath ) ) {
				keys = keypath.slice();
			} else {
				keys = _internal.splitKeypath( keypath );
			}

			normalised = keys.join( '.' );

			// Clear cache
			this._clearCache( normalised );

			// update data
			obj = this.data;
			while ( keys.length > 1 ) {
				key = keys.shift();

				// If this branch doesn't exist yet, create a new one - if the next
				// key matches /^[0-9]+$/, assume we want an array branch rather
				// than an object
				if ( !obj[ key ] ) {
					obj[ key ] = ( /^[0-9]+$/.test( keys[0] ) ? [] : {} );
				}

				obj = obj[ key ];
			}

			key = keys[0];

			obj[ key ] = value;

			// Fire set event
			if ( !this.setting ) {
				this.setting = true; // short-circuit any potential infinite loops
				this.fire( 'set', normalised, value );
				this.fire( 'set:' + normalised, value );
				this.setting = false;
			}

			// Trigger updates of views that observe `keypaths` or its descendants
			this._notifyObservers( normalised );

			// See if we can resolve any of the unresolved keypaths (if such there be)
			i = this._pendingResolution.length;
			while ( i-- ) { // Work backwards, so we don't go in circles!
				unresolved = this._pendingResolution.splice( i, 1 )[0];

				// If we can't resolve the reference, add to the back of
				// the queue (this is why we're working backwards)
				if ( !this.resolveRef( unresolved ) ) {
					this._pendingResolution[ this._pendingResolution.length ] = unresolved;
				}
			}
		},

		_setMultiple: function ( map ) {
			var keypath;

			for ( keypath in map ) {
				if ( map.hasOwnProperty( keypath ) ) {
					this._setSingle( keypath, map[ keypath ] );
				}
			}
		},

		_clearCache: function ( keypath ) {
			var children = this._cacheMap[ keypath ];

			delete this._cache[ keypath ];

			if ( !children ) {
				return;
			}

			while ( children.length ) {
				this._clearCache( children.pop() );
			}
		},

		get: function ( keypath ) {
			var keys, normalised, key, match, parentKeypath, parentValue, value, formatters;

			if ( _internal.isArray( keypath ) ) {
				keys = keypath.slice(); // clone
				normalised = keys.join( '.' );
			}

			else {
				// cache hit? great
				if ( this._cache.hasOwnProperty( keypath ) ) {
					return this._cache[ keypath ];
				}

				keys = _internal.splitKeypath( keypath );
				normalised = keys.join( '.' );
			}

			// we may have a cache hit now that it's been normalised
			if ( this._cache.hasOwnProperty( normalised ) ) {
				return this._cache[ normalised ];
			}

			// otherwise it looks like we need to do some work
			key = keys.pop();
			parentValue = ( keys.length ? this.get( keys ) : this.data );

			// is this a set of formatters?
			if ( match = /^⭆(.+)⭅$/.exec( key ) ) {
				formatters = _internal.getFormattersFromString( match[1] );
				value = this._format( parentValue, formatters );
			}

			else {
				if ( typeof parentValue !== 'object' || !parentValue.hasOwnProperty( key ) ) {
					return;
				}

				value = parentValue[ key ];
			}

			// update cacheMap
			if ( keys.length ) {
				parentKeypath = keys.join( '.' );

				if ( !this._cacheMap[ parentKeypath ] ) {
					this._cacheMap[ parentKeypath ] = [];
				}
				this._cacheMap[ parentKeypath ].push( normalised );
			}

			// Allow functions as values
			if ( typeof value === 'function' ) {
				value = value();
			}

			// Update cache
			this._cache[ normalised ] = value;
			
			return value;
		},

		update: function ( keypath ) {
			this._clearCache( keypath );
			this._notifyObservers( keypath );

			this.fire( 'update:' + keypath );
			this.fire( 'update', keypath );

			return this;
		},

		link: function ( keypath ) {
			var self = this;

			return function ( value ) {
				self.set( keypath, value );
			};
		},

		registerView: function ( view ) {
			var resolved, value, index;

			if ( view.parentFragment && ( view.parentFragment.indexRefs.hasOwnProperty( view.model.ref ) ) ) {
				// This isn't a real keypath, it's an index reference
				index = view.parentFragment.indexRefs[ view.model.ref ];

				value = ( view.model.fmtrs ? this._format( index, view.model.fmtrs ) : index );
				view.update( value );

				return; // This value will never change, and doesn't have a keypath
			}

			// See if we can resolve a keypath from this view's reference (e.g.
			// does 'bar' in {{#foo}}{{bar}}{{/foo}} mean 'bar' or 'foo.bar'?)
			resolved = this.resolveRef( view );

			if ( !resolved ) {
				// We may still need to do an update, event with unresolved
				// references, if the view has formatters that (for example)
				// provide a fallback value from undefined
				if ( view.model.fmtrs ) {
					view.update( this._format( undefined, view.model.fmtrs ) );
				}

				this._pendingResolution[ this._pendingResolution.length ] = view;
			}
		},

		// Resolve a full keypath from `ref` within the given `contextStack` (e.g.
		// `'bar.baz'` within the context stack `['foo']` might resolve to `'foo.bar.baz'`
		resolveRef: function ( view ) {

			var ref, contextStack, keys, lastKey, innerMostContext, contextKeys, parentValue, keypath;

			ref = view.model.ref;
			contextStack = view.contextStack;

			// Implicit iterators - i.e. {{.}} - are a special case
			if ( ref === '.' ) {
				keypath = contextStack[ contextStack.length - 1 ];
			}

			else {
				keys = _internal.splitKeypath( ref );
				lastKey = keys.pop();

				// Clone the context stack, so we don't mutate the original
				contextStack = contextStack.concat();

				// Take each context from the stack, working backwards from the innermost context
				while ( contextStack.length ) {

					innerMostContext = contextStack.pop();
					contextKeys = _internal.splitKeypath( innerMostContext );

					parentValue = this.get( contextKeys.concat( keys ) );

					if ( parentValue.hasOwnProperty( lastKey ) ) {
						keypath = innerMostContext + '.' + ref;
						break;
					}
				}

				if ( !keypath && this.get( ref ) !== undefined ) {
					keypath = ref;
				}
			}

			// If we have any formatters, we need to append them to the keypath
			if ( keypath ) {
				view.keypath = ( view.model.fmtrs ? keypath + '.' + _internal.stringifyFormatters( view.model.fmtrs ) : keypath );

				view.observerRefs = this.observe( view );
				view.update( this.get( view.keypath ) );

				return true; // indicate success
			}

			return false; // failure
		},

		// Internal method to format a value, using formatters passed in at initialization
		_format: function ( value, formatters ) {
			var i, numFormatters, formatter, name, args, fn;

			// If there are no formatters, groovy - just return the value unchanged
			if ( !formatters ) {
				return value;
			}

			// Otherwise go through each in turn, applying sequentially
			numFormatters = formatters.length;
			for ( i=0; i<numFormatters; i+=1 ) {
				formatter = formatters[i];
				name = formatter.name;
				args = formatter.args || [];

				// If a formatter was passed in, use it, otherwise see if there's a default
				// one with this name
				fn = this.formatters[ name ] || Ractive.formatters[ name ];

				if ( fn ) {
					value = fn.apply( this, [ value ].concat( args ) );
				}
			}

			return value;
		},




		_notifyObservers: function ( keypath ) {
			var self = this, observersGroupedByPriority = this._observers[ keypath ] || [], i, j, priorityGroup, observer;

			for ( i=0; i<observersGroupedByPriority.length; i+=1 ) {
				priorityGroup = observersGroupedByPriority[i];

				if ( priorityGroup ) {
					for ( j=0; j<priorityGroup.length; j+=1 ) {
						observer = priorityGroup[j];
						observer.update( self.get( observer.keypath ) );
					}
				}
			}
		},

		observe: function ( view ) {

			var self = this, observerRefs = [], observe, keys, priority = view.model.p || 0;

			observe = function ( keypath ) {
				var observers;

				observers = self._observers[ keypath ] = self._observers[ keypath ] || [];
				observers = observers[ priority ] = observers[ priority ] || [];

				observers[ observers.length ] = view;
				observerRefs[ observerRefs.length ] = {
					keypath: keypath,
					priority: priority,
					view: view
				};
			};

			keys = _internal.splitKeypath( view.keypath );
			while ( keys.length > 1 ) {
				observe( keys.join( '.' ) );

				// remove the last item in the keypath, so that `data.set( 'parent', { child: 'newValue' } )`
				// affects views dependent on `parent.child`
				keys.pop();
			}

			observe( keys[0] );

			return observerRefs;
		},

		unobserve: function ( observerRef ) {
			var priorityGroups, observers, index, i, len;

			priorityGroups = this._observers[ observerRef.keypath ];
			if ( !priorityGroups ) {
				// nothing to unobserve
				return;
			}

			observers = priorityGroups[ observerRef.priority ];
			if ( !observers ) {
				// nothing to unobserve
				return;
			}

			if ( observers.indexOf ) {
				index = observers.indexOf( observerRef.observer );
			} else {
				// fuck you IE
				for ( i=0, len=observers.length; i<len; i+=1 ) {
					if ( observers[i] === observerRef.view ) {
						index = i;
						break;
					}
				}
			}


			if ( index === -1 ) {
				// nothing to unobserve
				return;
			}

			// remove the observer from the list...
			observers.splice( index, 1 );

			// ...then tidy up if necessary
			if ( observers.length === 0 ) {
				delete priorityGroups[ observerRef.priority ];
			}

			if ( priorityGroups.length === 0 ) {
				delete this._observers[ observerRef.keypath ];
			}
		},

		unobserveAll: function ( observerRefs ) {
			while ( observerRefs.length ) {
				this.unobserve( observerRefs.shift() );
			}
		}
	};


	// helper functions
	getEl = function ( input ) {
		var output, doc;

		if ( typeof window === 'undefined' ) {
			return;
		}

		doc = window.document;

		if ( !input ) {
			throw new Error( 'No container element specified' );
		}

		// We already have a DOM node - no work to do
		if ( input.tagName ) {
			return input;
		}

		// Get node from string
		if ( typeof input === 'string' ) {
			// try ID first
			output = doc.getElementById( input );

			// then as selector, if possible
			if ( !output && doc.querySelector ) {
				output = doc.querySelector( input );
			}

			// did it work?
			if ( output.tagName ) {
				return output;
			}
		}

		// If we've been given a collection (jQuery, Zepto etc), extract the first item
		if ( input[0] && input[0].tagName ) {
			return input[0];
		}

		throw new Error( 'Could not find container element' );
	};

	return Ractive;

}());