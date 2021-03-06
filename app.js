

/***************************************************************************************************************
****************************************************************************************************************

This is a microservice that pulls EMC install base from Ops Console.
It runs continuously, hosted on Pivotal Cloud Foundry. Every 24 hours it queries the ops console API:

- Pulls the current master list of customer GDUNs from the ECS repo.
- Iterates through all of the customer GDUNs specified in the master list.
- For each customer GDUN, it pulls the install base data from ops-console and stores the result in JSON format in ECS.

The result is a list of objects (number of objects = number of GDUNS) stored in ECS.
The name format used is <GDUN>.json. 

The objects can then be queried by middle tier apps like munger1 to ultimately return answers to questions like:
'How many VNXs does CustomerXYZ have?'

/***************************************************************************************************************
****************************************************************************************************************/


var AWS = require( "aws-sdk" ), // use the generic AWS SDK for s3 API
	ECS = require( "aws-sdk" ), // use a specific config for pointing to ECS
	request = require( "request" ), // use the request library to make http call to ops-console API
	async = require( "async" ), // use the async library to structure sequencing of load and store logic
	cfenv = require("cfenv")

// try and set the vcap from a local file, if it fails, appEnv will be set to use
// the PCF user provided service specified with the getServiceCreds call
var localVCAP  = null	
try {
	localVCAP = require("./local-vcap.json")
	} catch(e) {}

var appEnv = cfenv.getAppEnv({vcap: localVCAP}) // vcap specification is ignored if not running locally
var creds  = appEnv.getServiceCreds('ecs-creds-service') || {}
	
// setup ECS config to point to Bellevue lab 
var ECSconfig = {
  s3ForcePathStyle: true,
  endpoint: new AWS.Endpoint('http://10.5.208.212:9020'), // store to node 1 of 4 node cluster
  accessKeyId: creds.accessKeyId,
  secretAccessKey: creds.secretAccessKey
};

console.log('ECSconfig = ' + JSON.stringify(ECSconfig) );

// Trying vcap instead of below to get credentials
// ECS.config.loadFromPath(__dirname + '/ECSconfig.json');
var ecs = new ECS.S3(ECSconfig);
console.log(ecs);

// launch the ecs-loader process
console.log('starting cycleThru')
cycleThru();

// This is the master function that calls the 2 supporting functions in series to
// 1) get the list of GDUNS and then 2) process each one
function cycleThru() {	
	var customerListSource = 'PNWandNCAcustomers.json',
		GDUNarray = [];

    async.series([
        // get customer GDUN list from ECS object store
        function(callback) {
            getCustomerList(customerListSource, function(err, GDUNS) {				
                if (err) return callback(err); // return prevents a double callback with process continuing 
				GDUNarray = GDUNS;
				callback(); // this is the callback saying this function is complete
            });
        },
		
        // get install base data for each GDUN and post to ECS
        function(callback) {
            processGDUN(GDUNarray, function(err) {             
				if (err) {
					callback(err);
				} else {
					callback(); // this is the callback saying this function is complete
				}			
            });
        }
    ], function(err) {	
		if (err) {
			console.log('Full cycle likely not complete, error: ' + err);
		} else {
			console.log('Full cycle completed successfully');
		}
		var datetime = new Date();
		console.log('Cycle ended on: ' + datetime);	
		console.log('now waiting 24 hrs before starting cycle again...');
		//restart the whole cycle again from the top after wait time
		setTimeout(function() {
			cycleThru();
		}, 86400000); // 86400000 = loop through 1 every 24 hours			
    });
}

// This function gets the master list of customer GDUNs from the ECS repo.
// It returns that list as the 'GDUNS' array.
function getCustomerList(source, callback) {
	console.log('entering getCustomerList function')
	// get json data object from ECS bucket	
	var GDUNS = [];
	var params = {
			Bucket: 'installBase',
			Key: source
	};  
	  
	ecs.getObject(params, function(err, data) {
		if (err) {
			callback(err, null); // this is the callback saying getCustomerList function is complete but with an error
		} else { // success					
			console.log(data.Body.toString()); // note: Body is outputted as type buffer which is an array of bytes of the body, hence toString() 
			var dataPayload = JSON.parse(data.Body);
			
			// load GDUNS array
			for (var i = 0; i < dataPayload.length; i++) {
				GDUNS.push(dataPayload[i].gduns);
			}
			
			// free up memory
			data = null; 
			dataPayload = null;
			
			callback(null, GDUNS)  // this is the callback saying getCustomerList function is complete
		}
	});
}
		
// This function iterates through all of the customer GDUNs, pulling the install base data from ops-console
// for each GDUN, and then storing the result in JSON format in ECS.	
function processGDUN(GDUNlist, callback) {
	async.forEachSeries(GDUNlist, function(gdun, callback) {
		var jsonBodyToStore;

		async.series([
			// Pull install base data from ops-console 
			function(callback) {
				getIBjson(gdun, function(err, jsonBody) {
					if (err) {
						console.log('Error getting install base data for GDUN: ' + gdun + '\n       Error = ' + err);
						callback(err); // this is the task callback saying this function is complete but with an error;	
					} else {
						jsonBodyToStore = jsonBody;
						callback(); // this is the task callback saying this function is complete;					
					}
				});
			},
			// Store the resulting insight in ECS
			function(callback) {
				storeIBjson(gdun, jsonBodyToStore, function(err, customerStored) {
					if (err) return callback(err); // task callback saying this function is complete but with an error, return prevents double callback
					callback(); // this is the task callback saying this function is complete;
				});
			}
		], function(err) { // this function gets called after the two tasks have called their "task callbacks"
			if (err) {
				callback(err); // this is the callback saying this run-thru of the series is complete for a given gdun in the async.forEach but with error
			} else {			
				callback()				
			}
		});						
	
	}, 	function(err) {
			if (err) return callback(err);
			callback(); // this is the callback saying all items in the async.forEach are completed
	});
}	

// This function pulls the install base data for a given GDUN from ops-console
// and then provides the resulting json body in a callback to the calling function.
function getIBjson(gdun, callback) {	

	var nineDigitGdun = appendZeros(gdun);

	// build the URL for the API call 
	var url = "http://pnwreport.bellevuelab.isus.emc.com/api/installs/" + nineDigitGdun;	

	// pull the results from the API call
	request(url, function (error, response, body) {
		if (error) { 
			callback(err);			
		} else { // install base data was successfully loaded
			callback(null, body); // this is the  callback saying this getIBdata function is complete;
		}
	});		
}

// This function stores the IB json in ECS
function storeIBjson(gdun, jsonBodyToStore, callback) {				

	// put the data in the ECS bucket
	var params = {
		Bucket: 'installBase',
		Key: gdun + '.json',
		Body: JSON.stringify(jsonBodyToStore)
	};	  
	  
	ecs.putObject(params, function(err, data) {
		if (err) {
			// an error occurred
			console.log('Error in ECS putObject: ' + err, err.stack); 
		} else {
			// successful response
			
			try {
				var parsedBodyToStore = JSON.parse(jsonBodyToStore);
				var customer = parsedBodyToStore.rows[0].CS_CUSTOMER_NAME;																	
			} catch (e) {
				var customer = 'not able to retrieve';
			}		
	
			console.log(gdun + '.json object saved to ECS for customer: ' + customer);
			jsonBodyToStore = null; // free up memory
			callback(null, customer); // this is the  callback saying this storeIBjson function is complete			
		};
	});
}

// This function appends zeros to the beginning of GDUN numbers in case they are less than 9 characters and missing leading zeros
function appendZeros(gdun) {
	var gdunString = gdun.toString();
	var realGdun;

	if (gdunString.length == 9) {
		realGdun = gdunString;
	} else if (gdunString.length == 8) {
		realGdun = '0' + gdunString;
	} else if (gdunString.length == 7) {
		realGdun = '00' + gdunString;
	}

	return realGdun;
}
